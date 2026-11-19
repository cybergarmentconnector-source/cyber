'use client';
import { createContext, ReactNode, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api, useApi, clearApiCache, setDataVersion, prefetchApi, restorePersisted, useUpdating, loadAllForPrint } from '@/lib/api';
import { routeKeys, tabKeys } from '@/lib/keys';
import { endNav, startNav, useNavigate, usePendingNav } from '@/lib/nav';
import { balanceDate, CompanyInfo, defaultPeriod, financialYears, freshness, fyLabel, Period, periodText, presets, syncedText, todayIso } from '@/lib/period';
import { Icon } from './icons';
import { formatDate } from '@/lib/money';
import { qs } from '@/lib/qs';
import { DatePicker, Select } from './pickers';
import { PageSkeleton, SkeletonBody, SkText } from './ui';
import { ConnectTally } from './connect';

interface Me { user: { id: string; name: string; email: string; role: 'owner' | 'viewer' }; tenant: { name: string }; companies: CompanyInfo[] }
const Ctx = createContext<{ me: Me; company: CompanyInfo; reloadMe: () => void } | null>(null);
export const useCompany = () => { const c = useContext(Ctx); if (!c) throw new Error('No company'); return c; };

const NAV = [
  { href: 'dashboard', label: 'Dashboard', icon: Icon.dashboard },
  { href: 'sales', label: 'Sales', icon: Icon.sales },
  { href: 'purchases', label: 'Purchases', icon: Icon.purchases },
  { href: 'receipts', label: 'Receipts', icon: Icon.receipts },
  { href: 'payments', label: 'Payments', icon: Icon.payments },
  { href: 'receivables', label: 'Receivables', icon: Icon.receivables },
  { href: 'payables', label: 'Payables', icon: Icon.payables },
  { href: 'stock', label: 'Stock', icon: Icon.stock },
  { sep: true },
  { href: 'sync', label: 'Sync Status', icon: Icon.sync },
] as const;

export function AppShell({ cid, children }: { cid: string; children: ReactNode }) {
  // A newly opened window starts with the account saved by the last one (then refreshes it), so the app and the page's
  // own requests start at once instead of waiting for /v1/me. Runs before useApi's first load (effects run in order).
  useEffect(() => { restorePersisted(); }, []);
  const { data: me, error, reload } = useApi<Me>('/v1/me', 60_000);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useNavigate();
  const updating = useUpdating();
  // A page being opened shows its loading shape at once (lib/nav.ts) until the router has switched to it.
  const pending = usePendingNav();
  useEffect(() => { endNav(); }, [pathname]);
  useLayoutEffect(() => { if (pending) window.scrollTo(0, 0); }, [pending]);
  useEffect(() => setOpen(false), [pathname, pending]);   // phone menu closes as soon as a page starts opening
  useEffect(() => { const t = setInterval(reload, 120_000); return () => clearInterval(t); }, [reload]);
  // No company yet (just connected, first sync running): check every few seconds so the reports open as soon as data arrives.
  const waiting = !!me && me.companies.length === 0;
  useEffect(() => { if (!waiting) return; const t = setInterval(reload, 5_000); return () => clearInterval(t); }, [waiting, reload]);
  const cur = me?.companies.find(c => c.id === cid);
  const dataVersion = cur?.dataVersion ?? cur?.lastPublishedAt ?? '';
  useEffect(() => { setDataVersion(dataVersion ?? ''); }, [dataVersion]);
  // Menu pages load in the background so switching tabs is instant.
  useEffect(() => { if (cid !== 'none') for (const n of NAV) if ('href' in n) router.prefetch(`/c/${cid}/${n.href}`); }, [cid, router]);
  // Same-site links move between pages inside the app instead of reloading it (keeps the signed-in state and cached reports in memory).
  useEffect(() => {
    const anchor = (t: EventTarget | null) => (t instanceof Element ? t.closest('a') : null) as HTMLAnchorElement | null;
    /** The in-app link under the pointer: a real link, or a table row that opens a page (data-href). */
    const target = (t: EventTarget | null) => (t instanceof Element ? t.closest('a[href], [data-href]') : null) as HTMLElement | null;
    let hovered: HTMLElement | null = null, timer: number | undefined;
    const withPeriod = (a: HTMLAnchorElement) => {            // menu links carry the current period over
      if (!a.dataset.keepPeriod) return;
      const cur = new URLSearchParams(location.search), u = new URL(a.href, location.href);
      for (const k of ['from', 'to']) { const v = cur.get(k); if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
      a.setAttribute('href', u.pathname + u.search);
    };
    // Pointer resting on (or focus/touch on) any in-app link or linked row: load that page's code and its data now, so the
    // click opens it instantly with figures. Hovering over rows waits a moment, so sweeping across a table loads nothing.
    const warm = (el: HTMLElement) => {
      const raw = el instanceof HTMLAnchorElement ? el.href : el.dataset.href;
      if (!raw || (el instanceof HTMLAnchorElement && (el.hasAttribute('download') || (el.target && el.target !== '_self')))) return;
      const u = new URL(raw, location.href);
      if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
      router.prefetch(u.pathname + u.search);
      if (cur) for (const k of routeKeys(u, cur)) prefetchApi(k);
    };
    const onHover = (e: Event) => {
      const el = target(e.target); if (!el) return;
      if (el instanceof HTMLAnchorElement) withPeriod(el);
      if (e.type !== 'pointerover' || el.dataset.tab) { warm(el); return; }   // menu tabs, keyboard focus and touch: at once
      if (el === hovered) return;
      hovered = el; window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (hovered === el) { hovered = null; warm(el); } }, 90);
    };
    const onLeave = (e: Event) => { const el = target(e.target); if (el && el === hovered && !el.contains((e as PointerEvent).relatedTarget as Node | null)) { hovered = null; window.clearTimeout(timer); } };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = anchor(e.target);
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('#')) return;
      withPeriod(a);
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
      e.preventDefault();
      startNav(u.pathname + u.search);
      router.push(u.pathname + u.search + u.hash);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('pointerover', onHover);
    document.addEventListener('pointerout', onLeave);
    document.addEventListener('focusin', onHover);
    document.addEventListener('touchstart', onHover, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', onClick); document.removeEventListener('pointerover', onHover); document.removeEventListener('pointerout', onLeave);
      document.removeEventListener('focusin', onHover); document.removeEventListener('touchstart', onHover);
    };
  }, [router, cur]);
  if (error && !me) return <div className="login-wrap"><div className="login"><h1>Could not load your account</h1><p className="muted">{error.message}</p><button className="btn" onClick={reload}>Try again</button></div></div>;
  if (!me) return <ShellSkeleton cid={cid} />;
  const company = me.companies.find(c => c.id === cid);
  if (!company) {
    return (
      <div className="login-wrap"><div className="login">
        <h1>{me.companies.length ? 'Company not available' : 'No companies yet'}</h1>
        <p className="muted">{me.companies.length ? 'You do not have access to this company.' : me.user.role === 'owner' ? 'Connect the Windows PC that has Tally. Your reports appear here after the first sync.' : 'The account owner needs to connect the PC that has Tally.'}</p>
        {me.companies[0] && <a className="btn primary" href={`/c/${me.companies[0].id}/dashboard`}>Open {me.companies[0].name}</a>}
        {!me.companies.length && me.user.role === 'owner' && <ConnectTally />}
      </div></div>);
  }
  const section = pathname.split('/')[3] ?? 'dashboard';
  const navSection = pending ? pending.split('?')[0].split('/')[3] ?? section : section;   // highlight the menu item at once
  const fr = freshness(company);
  const logout = async () => { await api('/v1/auth/logout', { method: 'POST' }).catch(() => {}); clearApiCache(); location.href = '/login'; };
  return (
    <Ctx.Provider value={{ me, company, reloadMe: reload }}>
      <div className="shell">
        <nav className={`nav${open ? ' open' : ''}`} aria-label="Reports">
          <NavMenu cid={cid} section={navSection} />
          <div className="nav-foot">{me.tenant.name}<br />View-only · data from Tally</div>
        </nav>
        <div className={`scrim${open ? ' open' : ''}`} onClick={() => setOpen(false)} />
        <div className="main">
          <header className="topbar">
            <button className="btn ghost menu-btn" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}><Icon.menu /></button>
            <label className="sr-only" htmlFor="company-select">Company</label>
            <Select id="company-select" ariaLabel="Company" value={cid} onChange={v => navigate(`/c/${v}/${section}`)} style={{ maxWidth: 280, fontWeight: 600 }}
              options={me.companies.map(c => ({ value: c.id, label: c.name }))} />
            <span className="spacer" />
            <a href={`/c/${cid}/sync`} className={`fresh ${fr.state}`} aria-label={`Sync status: ${fr.label}, last synced ${syncedText(company.lastPublishedAt)}`} title={company.lastPublishedAt ? `Last successful sync ${new Date(company.lastPublishedAt).toLocaleString('en-IN')}` : undefined}>
              <span className="dot" aria-hidden="true" /><span style={{ whiteSpace: 'nowrap' }}>{syncedText(company.lastPublishedAt)}</span>
            </a>
            <details style={{ position: 'relative' }} className="no-print">
              <summary className="avatar-btn" aria-label={`Account: ${me.user.name}`} title={me.user.name}><span aria-hidden="true" className="avatar">{(me.user.name.trim()[0] ?? '?').toUpperCase()}</span></summary>
              <div className="panel pop" style={{ position: 'absolute', right: 0, top: 44, width: 230, zIndex: 30, padding: 12 }}>
                <div style={{ fontWeight: 600 }}>{me.user.name}</div><div className="small muted">{me.user.email} · {me.user.role === 'owner' ? 'Owner' : 'Viewer'}</div>
                <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={logout}>Sign out</button>
              </div>
            </details>
          </header>
          <main id="content" className="content" aria-busy={updating || !!pending || undefined} data-updating={updating && !pending ? '' : undefined}>
            {fr.state === 'failed' && <div className="notice warn no-print" role="status"><span aria-hidden="true">!</span><div>The latest sync did not complete ({company.lastError}). Reports show the last complete data from {syncedText(company.lastPublishedAt)}.</div></div>}
            {fr.state === 'never' && <div className="notice info no-print"><span aria-hidden="true">i</span><div>This company has not been synced yet. Reports will appear after the connector's first sync.</div></div>}
            <div className="print-only small" style={{ marginBottom: 8 }}>{company.name} · printed {formatDate(todayIso())} · data synced {syncedText(company.lastPublishedAt)}</div>
            {pending && <RouteSkeleton href={pending} />}
            {/* The current page stays mounted (hidden) until the router switches, so nothing is lost if the move is cancelled. */}
            <div className="route-view" hidden={!!pending}><Suspense fallback={<RouteSkeleton />}>{children}<TabPreloader /></Suspense></div>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

/** URL query state: filters live in the URL so Back restores company, period and filters. */
export function useQuery() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const get = useCallback((k: string, d = '') => sp.get(k) ?? d, [sp]);
  const set = useCallback((patch: Record<string, string | null | undefined>, push = false) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') n.delete(k); else n.set(k, v); }
    if (!('page' in patch)) n.delete('page');
    const url = `${pathname}${n.toString() ? `?${n}` : ''}`;
    // Same page, new filters: the pages read them in the browser, so the address changes at once without asking the server
    // (Next.js keeps useSearchParams and Back/Forward in step with the native history API). In-page tabs switch instantly.
    push ? window.history.pushState(null, '', url) : window.history.replaceState(null, '', url);
  }, [sp, pathname]);
  return { get, set, sp };
}

export function usePeriod(): [Period, (p: Period) => void] {
  const { company } = useCompany();
  const { get, set } = useQuery();
  const def = useMemo(() => defaultPeriod(company), [company]);
  const from = get('from'), to = get('to');
  const p = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { from, to } : def;
  return [p, (n: Period) => set({ from: n.from, to: n.to })];
}

export { qs };

/** Period picker. `inline` = shown as the dates under the page title (PageHead `period`), not as a bordered button. */
export function PeriodControl({ period, onChange, inline }: { period: Period; onChange: (p: Period) => void; inline?: boolean }) {
  const { company } = useCompany();
  const fys = financialYears(company);
  const ps = presets(company);
  const matchFy = fys.find(f => f.from === period.from && f.to === period.to);
  const matchPreset = ps.find(p => p.period.from === period.from && p.period.to === period.to);
  const [custom, setCustom] = useState(!matchFy && !matchPreset);
  const value = custom ? 'custom' : matchFy ? `fy:${matchFy.from}` : matchPreset ? `p:${matchPreset.key}` : 'custom';
  const pick = (v: string) => {
    if (v === 'custom') { setCustom(true); return; }
    setCustom(false);
    if (v.startsWith('fy:')) onChange(fys.find(f => `fy:${f.from}` === v)!);
    else onChange(ps.find(p => `p:${p.key}` === v)!.period);
  };
  const options = [
    { group: 'Financial year', options: fys.map(f => ({ value: `fy:${f.from}`, label: fyLabel(f) })) },
    { group: 'Quick ranges', options: ps.map(p => ({ value: `p:${p.key}`, label: p.label })) },
    { value: 'custom', label: 'Custom dates…' },
  ];
  const range = (
    <div className={`date-range${inline ? ' plain' : ''}`} role="group" aria-label="Custom dates">
      <DatePicker ariaLabel="From date" value={period.from} max={period.to} onChange={d => onChange({ ...period, from: d })} />
      <span className="date-range-sep" aria-hidden="true">–</span>
      <DatePicker ariaLabel="To date" value={period.to} min={period.from} onChange={d => onChange({ ...period, to: d })} />
    </div>);
  // Under the page title the period always reads as its dates, "1 Apr 2026 – 31 Mar 2027 ⌄": the arrow (or, for a
  // financial year / quick range, the whole line) opens the period menu; with custom dates each date opens its calendar.
  if (inline) return (
    <div className="period-inline" role="group" aria-label="Reporting period">
      {custom && range}
      <Select id="period" className="sel-text" ariaLabel="Period" display={custom ? '' : periodText(period)} value={value} onChange={pick} options={options} />
    </div>);
  return (
    <div className="toolbar period-control" role="group" aria-label="Reporting period">
      <Select id="period" ariaLabel="Period" value={value} onChange={pick} options={options} />
      {/* Custom dates: one field holding both ends, "1 Apr 2026 – 31 Mar 2027"; each date opens its own calendar. */}
      {custom && range}
    </div>
  );
}

export function AsOfControl({ asOf, onChange, periodEnd }: { asOf: string; onChange: (d: string) => void; periodEnd: string }) {
  return (
    <div className="toolbar" role="group" aria-label="As of date">
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>As of
        <DatePicker ariaLabel="As of date" value={asOf} onChange={onChange} />
      </label>
      <button className="btn sm" onClick={() => onChange(todayIso())}>Today</button>
      {asOf !== periodEnd && <button className="btn sm" onClick={() => onChange(periodEnd)}>Period end</button>}
    </div>
  );
}

/** The "Outstanding as of 19 Nov 2026 ⌄" line under a page title: pressing it opens the calendar to choose the as-of date. */
export function AsOfSub({ asOf, onChange }: { asOf: string; onChange: (d: string) => void }) {
  return <DatePicker plain ariaLabel="As of date" prefix="Outstanding as of " value={asOf} onChange={onChange} />;
}

/**
 * Page title block. `period` puts the reporting period under the title as clickable dates
 * ("1 Apr 2026 – 31 Mar 2027 ⌄") that open the period menu (financial years, quick ranges, custom dates) — the one place
 * a page shows and changes its period. `sub` = any other line of detail; `children` = buttons on the right (Print…).
 */
export function PageHead({ title, sub, crumbs, period, children }: {
  title: ReactNode; sub?: ReactNode; crumbs?: { href?: string; label: ReactNode }[];
  period?: { value: Period; onChange: (p: Period) => void }; children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="titles">
        {crumbs && <nav className="crumbs" aria-label="Breadcrumb">{crumbs.map((c, i) => <span key={i}>{c.href ? <a href={c.href}>{c.label}</a> : c.label}{i < crumbs.length - 1 && <span aria-hidden="true"> /</span>}</span>)}</nav>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
        {period && <div className="sub period-sub"><PeriodControl period={period.value} onChange={period.onChange} inline /></div>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function PrintButton() {
  // Lists load their remaining rows first, so the printout has the whole sheet.
  return <button className="btn no-print print-btn" aria-label="Print" onClick={async () => { await loadAllForPrint(); requestAnimationFrame(() => window.print()); }}><Icon.print /><span className="btn-text">Print</span></button>;
}

export const cpath = (cid: string, path: string, params?: Record<string, string | null | undefined>) => {
  const q = params ? qs(params) : '';
  return `/c/${cid}/${path}${q ? `?${q}` : ''}`;
};


/**
 * Loads every menu tab's data in the background once the current page has its data, one request at a time while the
 * browser is idle. The first visit to a tab then opens instantly from cache, like a revisit. Re-runs when the period
 * or the published data changes (cached copies are then out of date).
 */
function TabPreloader() {
  const { company } = useCompany();
  const [period] = usePeriod();
  const version = company.dataVersion ?? company.lastPublishedAt ?? '';
  useEffect(() => {
    let stop = false;
    const idle = () => new Promise<void>(r => ('requestIdleCallback' in window ? (window as any).requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 200)));
    const t = window.setTimeout(async () => {
      const all = Object.values(tabKeys(company.id, period)).flat();
      for (const k of all) { if (stop) return; await idle(); if (stop) return; await prefetchApi(k); }
    }, 800);   // let the page you opened load first
    return () => { stop = true; window.clearTimeout(t); };
  }, [company.id, period.from, period.to, version]);
  return null;
}


/* ── Opening pages instantly ─────────────────────────────────────────────────────────────────────────────────────────
 * Every page opens the moment it is clicked. Until its code and data arrive, it shows its own shape: the real title
 * (and period) where it is already known, grey placeholders for everything else. The same placeholder is used for:
 *   • switching menu tabs and opening a ledger / item / voucher  → app/c/[cid]/…/loading.tsx  → RouteSkeleton
 *   • a page waiting for its data                                → the page renders <Loading page /> or RouteSkeleton
 *   • a newly opened window or tab, or switching company         → ShellSkeleton (menu + top bar + RouteSkeleton)
 * Links and rows also preload the page and its data on hover (AppShell), so most of the time the placeholder is not
 * even needed. */

const NavBrand = () => (
  <div className="nav-brand"><span className="logo"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg></span>Business Reports</div>);

function NavMenu({ cid, section }: { cid: string; section: string }) {
  return (<>
    <NavBrand />
    <ul>
      {NAV.map((n, i) => 'sep' in n ? <li key={i} className="nav-sep" role="separator" /> : (
        <li key={n.href}><a href={cid ? `/c/${cid}/${n.href}` : '/'} data-tab={n.href} data-keep-period={n.href === 'sync' ? undefined : '1'} aria-current={section === n.href ? 'page' : undefined}><n.icon />{n.label}</a></li>
      ))}
    </ul>
  </>);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRINT = 78;   // placeholder width of the Print button

/**
 * The placeholder for the page at the current address (or `href`), shaped exactly like that page while it loads.
 * Works with or without the company loaded (in a new window the menu and title show before the account arrives).
 */
export function RouteSkeleton({ href }: { href?: string }) {
  const here = usePathname() ?? '';
  const hereSp = useSearchParams();
  const router = useRouter();
  const dest = href ? new URL(href, 'http://app') : null;   // the page being opened, when it is not the current address
  const pathname = dest ? dest.pathname : here;
  const sp: { get(k: string): string | null } | null = dest ? dest.searchParams : hereSp;
  const company = useContext(Ctx)?.company;
  const [, , cid = '', section = 'dashboard', id] = pathname.split('/');
  const from = sp?.get('from') ?? '', to = sp?.get('to') ?? '';
  const period = DATE.test(from) && DATE.test(to) ? { from, to } : company ? defaultPeriod(company) : null;
  const pt = period ? periodText(period) : undefined;   // undefined → grey bar
  const back = () => (history.length > 1 ? router.back() : router.push(cpath(cid, 'dashboard')));
  const withPeriod = (path: string) => cpath(cid, path, period ? { from: period.from, to: period.to } : undefined);

  let v: { cards?: number; ageing?: boolean; title?: string; sub?: ReactNode | null; crumbs?: { href?: string; label?: ReactNode }[]; controls: number[]; body: SkeletonBody; before?: ReactNode };
  if (id) {
    v = section === 'vouchers'
      ? { controls: [74, 104, PRINT], body: 'detail',
          before: <div className="no-print" style={{ marginBottom: 8 }}><button className="btn ghost sm" onClick={back}><Icon.back />Back</button></div> }
      : { crumbs: [{ href: withPeriod('stock'), label: 'Stock' }, {}], controls: [PRINT], body: 'report' };
  } else {
    const asOf = sp?.get('asOf') || (period ? balanceDate(period) : '');
    switch (section) {
      case 'sales': case 'purchases':
        v = { title: section === 'sales' ? 'Sales' : 'Purchases', sub: pt, controls: [PRINT], body: 'report', cards: 2 }; break;
      case 'receipts': case 'payments':
        v = { title: section === 'receipts' ? 'Receipts' : 'Payments', sub: pt, controls: [PRINT], body: 'report', cards: 2 }; break;
      case 'receivables': case 'payables':
        v = { title: section === 'receivables' ? 'Receivables' : 'Payables', sub: asOf ? `Outstanding as of ${formatDate(asOf)}` : undefined, controls: [150, 60, PRINT], body: 'report', cards: 0, ageing: true }; break;
      case 'stock': v = { title: 'Stock', sub: pt, controls: [PRINT], body: 'report' }; break;
      case 'sync': v = { title: 'Sync Status', sub: 'Connection between Tally on your PC and these reports', controls: [84], body: 'report' }; break;
      default: v = { title: 'Dashboard', sub: pt, controls: [], body: 'report' };
    }
  }
  return <PageSkeleton {...v} />;
}

/** The whole app frame while the account loads (a new window or tab, a company switch): working menu, top bar placeholders, page shape. */
export function ShellSkeleton({ cid }: { cid?: string }) {
  const pending = usePendingNav();   // a menu item clicked while the account is still loading opens at once too
  const pathname = usePathname() ?? '';
  const parts = (pending ? pending.split('?')[0] : pathname).split('/');
  const id = cid ?? parts[2] ?? '';
  return (
    <div className="shell" aria-busy="true">
      <nav className="nav" aria-label="Reports">
        <NavMenu cid={id} section={parts[3] ?? 'dashboard'} />
        <div className="nav-foot" aria-hidden="true"><SkText w={90} /><br />View-only · data from Tally</div>
      </nav>
      <div className="main">
        <header className="topbar" aria-hidden="true">
          <span className="sk sk-ctl" style={{ width: 200 }} />
          <span className="spacer" />
          <span className="sk sk-text hide-sm" style={{ width: 170 }} />
          <span className="sk sk-avatar" />
        </header>
        <main id="content" className="content"><Suspense fallback={<PageSkeleton />}><RouteSkeleton href={pending ?? undefined} /></Suspense></main>
      </div>
    </div>);
}
