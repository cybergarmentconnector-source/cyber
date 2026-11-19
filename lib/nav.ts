'use client';
/**
 * Instant page opening.
 *
 * Moving to another page needs a round trip to the server before Next.js can show it (unless it was preloaded in time).
 * So every in-app navigation goes through `startNav` first: the shell then shows the destination page's loading shape at
 * once (RouteSkeleton) and highlights its menu item, until the router has switched to it. Filters, period and paging on
 * the same page do not count: those keep the page in place, dimmed, while the new figures load.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

let pending: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());

/** Marks a page as being opened (address within the app). Ignored for the page already open. */
let guard: number | undefined;
export function startNav(href: string) {
  const u = new URL(href, location.href);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (u.pathname === location.pathname) { endNav(); return; }   // back to this page: it replaces any move still under way
  pending = u.pathname + u.search;
  window.clearTimeout(guard);
  guard = window.setTimeout(endNav, 20_000);                     // never leave a placeholder up if the move was dropped
  emit();
}

/** The router has switched pages (or Back/Forward was used): the real page takes over. */
export function endNav() { window.clearTimeout(guard); if (pending !== null) { pending = null; emit(); } }
if (typeof window !== 'undefined') window.addEventListener('popstate', endNav);

/** The address of the page being opened, or null. */
export const usePendingNav = () => useSyncExternalStore(
  cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => pending, () => null);

/** router.push / replace that opens the destination instantly (use for every move to another page). */
export function useNavigate() {
  const router = useRouter();
  return useCallback((href: string, opts?: { replace?: boolean; scroll?: boolean }) => {
    startNav(href);
    if (opts?.replace) router.replace(href, { scroll: opts.scroll }); else router.push(href, { scroll: opts?.scroll });
  }, [router]);
}
