'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!r.ok) {
    if (r.status === 401 && typeof window !== 'undefined') forgetPersisted();
    if (r.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(r.status, body?.error ?? 'error', body?.message ?? (r.status >= 500 ? 'The server could not load this report. Previously synced data is unchanged; try again shortly.' : `Request failed (${r.status})`));
  }
  return body as T;
}

const cache = new Map<string, { at: number; v: string; data: any }>();
const inflight = new Map<string, Promise<any>>();
let dataVersion = '';

/** Company data only changes when a sync is published. The shell sets this to the company's last-published time,
 *  so cached reports are reused until a new sync arrives (then they refresh in the background). */
export function setDataVersion(v: string) { dataVersion = v; }
const versioned = (path: string) => path.startsWith('/v1/companies/');

/* Small per-user responses kept across windows (localStorage), so a newly opened window or tab draws the app at once and
 * starts loading its page straight away, then refreshes them. Only the account and its company list: never report data. */
const PERSIST = new Set(['/v1/me']);
const storeKey = (path: string) => `br-cache:${path}`;
function remember(path: string, v: string, data: any) {
  cache.set(path, { at: Date.now(), v, data });
  if (PERSIST.has(path)) try { localStorage.setItem(storeKey(path), JSON.stringify(data)); } catch { /* storage full or blocked */ }
}
/** Puts the saved copies into the cache as already out of date (shown at once, refreshed straight away). Call after hydration. */
export function restorePersisted() {
  for (const path of PERSIST) {
    if (cache.has(path)) continue;
    try { const s = localStorage.getItem(storeKey(path)); if (s) cache.set(path, { at: 0, v: '', data: JSON.parse(s) }); } catch { /* ignore */ }
  }
}
/** The cached copy of a request, if any (restored copies included), without loading it. */
export function peekApi<T = any>(path: string): T | undefined { return cache.get(path)?.data; }
function forgetPersisted() { for (const path of PERSIST) try { localStorage.removeItem(storeKey(path)); } catch { /* ignore */ } }

/** Which response "shape" a request returns: its endpoint plus the params that change the layout (view, groupBy). */
const shapeOf = (path: string) => {
  const u = new URL(path, 'http://x');
  return `${u.pathname}|${u.searchParams.get('view') ?? ''}|${u.searchParams.get('groupBy') ?? ''}`;
};

/* Pages showing previous figures while new ones load ("updating"); the shell dims them meanwhile. */
let updating = 0;
const updatingSubs = new Set<() => void>();
const bumpUpdating = (d: number) => { updating += d; updatingSubs.forEach(f => f()); };
export const useUpdating = () => useSyncExternalStore(
  cb => { updatingSubs.add(cb); return () => { updatingSubs.delete(cb); }; }, () => updating > 0, () => false);

interface Held<T> { path: string | null; src: string | null; data: T | undefined; error: ApiError | null; loading: boolean; stale: boolean; partial: boolean }

/** Same report, any view (only the address' path, without the query). */
const reportOf = (path: string) => new URL(path, 'http://x').pathname;

/**
 * Fetch hook with stale-while-revalidate caching: a page you have seen shows instantly, then refreshes if it is old
 * or a newer sync has been published. Identical requests that are already in flight are shared.
 *
 * Data always belongs to the request it came from (`src`). When the request changes:
 *  - cached → shown at once;
 *  - same shape (only period / search / page / filters differ) → the previous figures stay, marked `stale` (dimmed);
 *  - another view of the same report (a tab) with `keepAcrossViews` → the previous data stays, marked `partial`: the page
 *    keeps its cards, chart and tabs (they do not depend on the view) and shows a placeholder only in the tab's content,
 *    so switching tabs never blanks or jumps the page;
 *  - otherwise (another report) → no data (placeholder), never the old view's data, which a page would render with the
 *    wrong layout (this crashed the Group tab).
 */
export function useApi<T = any>(path: string | null, maxAgeMs = 300_000, opts?: { keepAcrossViews?: boolean }) {
  const across = !!opts?.keepAcrossViews;
  /** How previous data (loaded for `src`) may stand in while `to` loads. */
  const keepAs = (src: string | null, hasData: boolean, to: string | null): 'stale' | 'partial' | null =>
    !hasData || !src || !to ? null : shapeOf(src) === shapeOf(to) ? 'stale' : across && reportOf(src) === reportOf(to) ? 'partial' : null;
  const [st, setSt] = useState<Held<T>>(() => {
    const hit = path ? cache.get(path) : undefined;
    return { path, src: hit ? path : null, data: hit?.data, error: null, loading: !!path && !hit, stale: false, partial: false };
  });
  const seq = useRef(0);
  const load = useCallback(async (force = false) => {
    if (!path) { setSt({ path, src: null, data: undefined, error: null, loading: false, stale: false, partial: false }); return; }
    const id = ++seq.current;
    const hit = cache.get(path);
    if (hit && !force) {
      const current = !versioned(path) || hit.v === dataVersion;
      setSt({ path, src: path, data: hit.data, error: null, loading: false, stale: false, partial: false });
      if (current && Date.now() - hit.at < maxAgeMs) return;
    } else if (!hit) {
      setSt(s => {
        const k = keepAs(s.src, s.data !== undefined, path);
        return { path, src: k ? s.src : null, data: k ? s.data : undefined, error: null, loading: k !== 'stale', stale: k === 'stale', partial: k === 'partial' };
      });
    }
    try {
      let p = inflight.get(path);
      if (!p) { p = api<T>(path).finally(() => inflight.delete(path)); inflight.set(path, p); }
      const d = await p;
      remember(path, dataVersion, d);
      if (id === seq.current) setSt({ path, src: path, data: d, error: null, loading: false, stale: false, partial: false });
    } catch (e: any) {
      if (id === seq.current) setSt(s => ({ ...s, path, error: e instanceof ApiError ? e : new ApiError(0, 'network', 'Could not reach the server. Check your connection.'), loading: false, stale: false }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, maxAgeMs, across]);
  useEffect(() => { load(); }, [load]);

  // The render right after the request changed (before the effect runs) follows the same rules.
  let view: Held<T> = st;
  if (st.path !== path) {
    const hit = path ? cache.get(path) : undefined;
    const k = hit ? null : keepAs(st.src, st.data !== undefined, path);
    view = hit ? { path, src: path, data: hit.data, error: null, loading: false, stale: false, partial: false }
      : { path, src: k ? st.src : null, data: k ? st.data : undefined, error: null, loading: !!path && k !== 'stale', stale: k === 'stale', partial: k === 'partial' };
  }
  useEffect(() => { if (!view.stale) return; bumpUpdating(1); return () => bumpUpdating(-1); }, [view.stale]);
  return { data: view.data, error: view.error, loading: view.loading, stale: view.stale, partial: view.partial, reload: () => load(true) };
}

/** A request's data from the cache if current, otherwise loaded (and cached). Shares requests already in flight. */
export async function fetchCached<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && (!versioned(path) || hit.v === dataVersion)) return hit.data;
  let p = inflight.get(path);
  if (!p) { p = api<T>(path).finally(() => inflight.delete(path)); inflight.set(path, p); }
  const d = await p;
  remember(path, dataVersion, d);
  return d;
}

/* Print asks every continuous list on the page to load its remaining rows first (PrintButton → loadAllForPrint). */
const LOAD_ALL = 'app:load-all';
export async function loadAllForPrint() {
  const waits: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent(LOAD_ALL, { detail: waits }));
  await Promise.all(waits).catch(() => {});
}

export interface InfiniteList<T = any> {
  /** The first page's response (totals, counts…). */
  data: T | undefined;
  /** Every row loaded so far, in order. */
  rows: any[];
  total: number; done: boolean; loading: boolean; loadingMore: boolean; stale: boolean; partial: boolean;
  error: ApiError | null; reload: () => void; loadMore: () => void;
  /** Loads every remaining page in the background, a few at a time (for figures that need the whole list). */
  loadAll: () => void;
}

/**
 * A list the server sends in pages, shown as ONE continuous sheet: the first page loads like any request (cached, kept
 * while filters change), the next pages load by themselves as the user scrolls near the end (<LoadMore list={…} />),
 * and the sheet stops at the last row. `keyFor(page)` = the request for a page; `listOf(response)` = where in the
 * response the list is: its `rows`, `total` (rows on all pages) and `pageSize`.
 */
type ListPart = { rows?: any[]; total?: number; pageSize?: number } | undefined;
export function useInfiniteApi<T = any>(keyFor: ((page: number) => string) | null, listOf: (d: any) => ListPart = d => d,
                                         opts?: { keepAcrossViews?: boolean }): InfiniteList<T> {
  const rowsOf = (d: any) => listOf(d)?.rows;
  const firstKey = keyFor ? keyFor(1) : null;
  const first = useApi<T>(firstKey, undefined, opts);
  const [more, setMore] = useState<{ base: string | null; pages: any[][]; loading: boolean; error: ApiError | null }>({ base: null, pages: [], loading: false, error: null });
  const cur = more.base === firstKey ? more : { base: firstKey, pages: [] as any[][], loading: false, error: null };
  const d: any = first.data;
  const fresh = !!d && !first.stale && !first.partial;           // never add pages to figures that belong to other filters
  const firstRows = (d && rowsOf(d)) ?? [];
  const part = d ? listOf(d) : undefined;
  const pageSize: number = part?.pageSize ?? Math.max(firstRows.length, 1);
  const total: number = part?.total ?? firstRows.length;
  const pagesTotal = Math.max(1, Math.ceil(total / pageSize));
  const loadedPages = 1 + cur.pages.length;
  const done = !fresh || loadedPages >= pagesTotal;
  const ref = useRef({ keyFor, rowsOf, firstKey, loadedPages, pagesTotal, done, busy: false });
  ref.current = { ...ref.current, keyFor, rowsOf, firstKey, loadedPages, pagesTotal, done };

  const fetchPages = useCallback((upTo: number) => {
    const r = ref.current;
    if (r.done || r.busy || !r.keyFor || !r.firstKey) return Promise.resolve();
    const base = r.firstKey, from = r.loadedPages + 1, to = Math.min(upTo, r.pagesTotal);
    if (from > to) return Promise.resolve();
    r.busy = true;
    setMore(m => ({ ...(m.base === base ? m : { base, pages: [], error: null }), loading: true }));
    const keyFor_ = r.keyFor, rowsOf_ = r.rowsOf;
    return Promise.all(Array.from({ length: to - from + 1 }, (_, i) => fetchCached<any>(keyFor_(from + i))))
      .then(ds => setMore(m => m.base === base && m.pages.length === from - 2
        ? { ...m, pages: [...m.pages, ...ds.map(x => rowsOf_(x) ?? [])], loading: false, error: null } : m))
      .catch(e => setMore(m => m.base === base ? { ...m, loading: false, error: e instanceof ApiError ? e : new ApiError(0, 'network', 'Could not load more rows.') } : m))
      .finally(() => { ref.current.busy = false; });
  }, []);
  const loadMore = useCallback(() => { void fetchPages(ref.current.loadedPages + 1); }, [fetchPages]);
  const loadAll = useCallback(async () => {
    for (let guard = 0; guard < 1000 && !ref.current.done && !ref.current.busy; guard++) {
      const before = ref.current.loadedPages;
      await fetchPages(before + 4);                                  // 4 pages at a time, not hundreds at once
      await new Promise(r => setTimeout(r, 0));                      // let React apply them (updates ref.current)
      if (ref.current.loadedPages === before) break;                 // nothing more came (error or filters changed)
    }
  }, [fetchPages]);

  useEffect(() => {   // printing: load everything first
    const onAll = (e: Event) => (e as CustomEvent<Promise<unknown>[]>).detail.push(fetchPages(Number.MAX_SAFE_INTEGER));
    window.addEventListener(LOAD_ALL, onAll);
    return () => window.removeEventListener(LOAD_ALL, onAll);
  }, [fetchPages]);

  return {
    data: first.data, rows: fresh ? [...firstRows, ...cur.pages.flat()] : firstRows, total, done,
    loading: first.loading, loadingMore: cur.loading, stale: first.stale, partial: first.partial,
    error: first.error ?? cur.error, reload: first.reload, loadMore, loadAll,
  };
}

/** Loads a request into the cache in the background, so the page that needs it opens instantly.
 *  Skipped when a current copy is cached; shares the request if the page asks for it meanwhile. Errors are ignored here. */
export function prefetchApi(path: string, maxAgeMs = 300_000): Promise<void> {
  const hit = cache.get(path);
  if (hit && (!versioned(path) || hit.v === dataVersion) && Date.now() - hit.at < maxAgeMs) return Promise.resolve();
  let p = inflight.get(path);
  if (!p) { p = api(path).finally(() => inflight.delete(path)); inflight.set(path, p); }
  const v = dataVersion;
  return p.then(d => { remember(path, v, d); }, () => {});
}

export function clearApiCache() { cache.clear(); inflight.clear(); forgetPersisted(); }
