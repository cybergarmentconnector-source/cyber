'use client';
import { KeyboardEvent, ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from '@/lib/nav';
import { Icon } from './icons';
import { formatIndian, drCr, formatDate, formatQty, INVOICE_DECIMALS } from '@/lib/money';
import { ApiError, prefetchApi, type InfiniteList } from '@/lib/api';

export const money = (v: string | null | undefined, places?: number) => formatIndian(v, places);
export const rupees = (v: string | null | undefined, places?: number) => {
  if (v === null || v === undefined || v === '') return '—';
  const f = formatIndian(v, places);
  return f.startsWith('-') ? `−₹ ${f.slice(1)}` : `₹ ${f}`;
};
export { drCr, formatDate, formatQty, INVOICE_DECIMALS };

/** Summary card. `action` = a small control in its top-right corner (e.g. the Net / Gross toggle). */
export function Card({ label, value, detail, href, onClick, selected, hint, action }: {
  label: string; value: ReactNode; detail?: ReactNode; href?: string; onClick?: () => void; selected?: boolean; hint?: string; action?: ReactNode;
}) {
  const body = (<><div className="k"><span>{label}</span>{hint && <span>{hint}</span>}{action}</div><div className="v">{value}</div>{detail && <div className="d">{detail}</div>}</>);
  if (href) return <a className={`card${selected ? ' selected' : ''}`} href={href}>{body}</a>;
  if (onClick) return <button type="button" className={`card${selected ? ' selected' : ''}`} onClick={onClick} aria-pressed={selected}>{body}</button>;
  return <div className="card">{body}</div>;
}

/** The name a table is filtered to (a customer, item, ledger, group…): bold, uppercase, in the UI blue. Nothing when unknown. */
export const FilterName = ({ children }: { children?: ReactNode }) => children ? <span className="filter-name">{children}</span> : null;

/**
 * Info box of the customer / party a sheet belongs to: its own small card above the sheet (never a bar inside it), a
 * blue heading row and one row of figures — e.g. Customer · Max overdue · Bills · Amount. The first cell is the name
 * (left-aligned), the rest are centred. `onClick` makes the row clickable (e.g. back to the full list).
 * Used by every one-customer sheet (Receivables / Payables, Sales / Purchases), so they all look the same.
 */
export interface InfoCell { label: string; value: ReactNode; strong?: boolean }
export function InfoBox({ caption, cells, onClick, expanded }: { caption: string; cells: InfoCell[]; onClick?: () => void; expanded?: boolean }) {
  const [name, ...rest] = cells;
  const act = onClick ? {
    className: 'clickable', tabIndex: 0, 'aria-expanded': expanded, onClick,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } },
  } : {};
  return (
    <section className="panel info-box">
      <div className="table-wrap">
        <table className="data cards-sm">
          <caption className="sr-only">{caption}</caption>
          <thead><tr><th className="name">{name.label}</th>{rest.map(c => <th key={c.label} className="num">{c.label}</th>)}</tr></thead>
          <tbody>
            <tr {...act}>
              <td className="name wrap primary-cell" data-label={name.label}>{name.value}</td>
              {rest.map(c => <td key={c.label} className="num" data-label={c.label}>{c.strong ? <b>{c.value}</b> : c.value}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </section>);
}

/** Option switch: a soft grey track with the chosen option on a white pill. `small` = compact (inside a card).
 *  `preload` starts loading what an option will show when the pointer reaches it, so switching is instant. */
export function Seg<T extends string>({ label, ariaLabel, value, options, onChange, small, preload }: {
  label?: string; ariaLabel?: string; value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void;
  small?: boolean; preload?: (v: T) => (string | null | undefined)[];
}) {
  const warm = (v: T) => { if (v !== value && preload) for (const k of preload(v)) if (k) prefetchApi(k); };
  return (
    <span className="seg-group" role="group" aria-label={ariaLabel ?? label}>
      {label && <span className="seg-label">{label}</span>}
      <span className={`seg${small ? ' sm' : ''}`}>{options.map(o => (
        <button type="button" key={o.value} title={o.title} aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          onPointerEnter={() => warm(o.value)} onFocus={() => warm(o.value)}>{o.label}</button>))}</span>
    </span>
  );
}

/* ── Tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Switching a tab must never blank or jump the page. The rules, used by every tabbed page:
 *  1. The page's data hook uses useApi(…, { keepAcrossViews: true }) (or a separate request for the tab's content), so
 *     cards, charts and the tabs themselves stay while the tab's data loads — only the tab's content waits.
 *  2. The tab's content sits in <TabPanel>, which keeps its height while a placeholder is showing, so nothing below moves.
 *  3. `preload` names the data each tab needs; it starts loading when the pointer or focus reaches the tab, so most
 *     switches show the data at once. DataTable resets its sort and row count for each view (no carried-over sort). */
export function Tabs<T extends string>({ value, options, onChange, label, preload }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
  /** Requests a tab will make, loaded ahead when the tab is pointed at or focused. */
  preload?: (v: T) => (string | null | undefined)[];
}) {
  const warm = (v: T) => { if (v !== value && preload) for (const k of preload(v)) if (k) prefetchApi(k); };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map(o => <button key={o.value} role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}
        onPointerEnter={() => warm(o.value)} onFocus={() => warm(o.value)} onTouchStart={() => warm(o.value)}>{o.label}</button>)}
    </div>
  );
}

/**
 * The content under a set of tabs. While it shows a loading placeholder it keeps the height of what was there before,
 * so the page below does not jump up and back; once the new content is in, it takes its own height.
 * Works for anything inside (tables, nested components that load on their own): it watches for placeholders itself.
 */
export function TabPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const check = () => {
    const el = ref.current; if (!el) return;
    if (el.querySelector('.skeleton, .sk-panel')) { if (last.current) el.style.minHeight = `${last.current}px`; }
    else { el.style.minHeight = ''; last.current = el.offsetHeight; }
  };
  useLayoutEffect(check);   // our own renders: before the browser paints
  useEffect(() => {          // content that loads by itself (a nested component): on every change inside
    const el = ref.current; if (!el) return;
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return <div ref={ref} className="tab-panel">{children}</div>;
}

/* ── Loading placeholders ──────────────────────────────────────────────────────────────────────────────────────────
 * One family of grey, shimmering shapes for everything that is still loading. Every page opens at once and shows the
 * shape of what is coming; the same shapes are used by the route loading screens (loading.tsx files under app/c → RouteSkeleton),
 * the shell's first load and the pages themselves, so "opening" → "loading" → "loaded" never jumps. */

/** A grey bar standing in for a line of text that is not known yet (a title, a subtitle, a breadcrumb). */
export const SkText = ({ w, big }: { w: number; big?: boolean }) => <span className={`sk sk-text${big ? ' big' : ''}`} style={{ width: w }} aria-hidden="true" />;
const SkRows = ({ n }: { n: number }) => <>{Array.from({ length: n }, (_, i) => <div key={i} className="sk sk-row" />)}</>;
const SkCards = ({ n = 4 }: { n?: number }) => n === 0 ? null : (
  <div className="cards">{Array.from({ length: n }, (_, i) => <div key={i} className="card"><div className="sk sk-line w40" /><div className="sk sk-line w70 big" /><div className="sk sk-line w55" /></div>)}</div>);
/** The invoice-age filter cards (All outstanding … Custom) of Receivables / Payables while they load. */
const SkAgeing = () => (
  <div className="ageing" aria-hidden="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="ageing-sk"><div className="sk sk-line w55" /><div className="sk sk-line w70" /></div>)}</div>);

/**
 * Placeholder while data loads, shaped like what will replace it so the page does not jump:
 * `page` = cards + table (a whole report), default = table rows (a section), `rows` = a few rows (inside a table),
 * `label` = one short line.
 */
export function Loading({ label, page = false, rows, cards = 4, ageing = false }: { label?: string; page?: boolean; rows?: number; cards?: number; ageing?: boolean }) {
  if (label) return <div className="empty" role="status" aria-live="polite">{label}</div>;
  if (rows) return <div className="sk-panel" role="status" aria-label="Loading"><SkRows n={rows} /></div>;
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {page && <SkCards n={cards} />}
      {page && ageing && <SkAgeing />}
      <div className={page ? 'panel sk-panel' : 'sk-panel'}><SkRows n={page ? 8 : 5} /></div>
    </div>);
}

/** Body shapes: `report` = cards + table, `list` = filters + table, `detail` = a document (voucher) panel. */
export type SkeletonBody = 'report' | 'list' | 'detail';

/**
 * A whole page that is still loading: its real heading where it is already known (title, period…), grey bars where it is
 * not, placeholder controls, and the body shape. `before` goes above the heading (e.g. a working Back button).
 */
export function PageSkeleton({ title, sub, crumbs, controls = [], body = 'report', cards = 4, ageing = false, before }: {
  cards?: number; ageing?: boolean; title?: ReactNode; sub?: ReactNode | null; crumbs?: { href?: string; label?: ReactNode }[];
  controls?: number[]; body?: SkeletonBody; before?: ReactNode;
}) {
  return (
    <div className="page-skeleton" role="status" aria-label="Loading" aria-busy="true">
      {before}
      <div className="page-head">
        <div className="titles">
          {crumbs && <nav className="crumbs" aria-label="Breadcrumb">{crumbs.map((c, i) => (
            <span key={i}>{c.label === undefined ? <SkText w={90} /> : c.href ? <a href={c.href}>{c.label}</a> : c.label}{i < crumbs.length - 1 && <span aria-hidden="true"> /</span>}</span>))}</nav>}
          <h1>{title ?? <SkText w={220} big />}</h1>
          {sub !== null && <div className="sub">{sub ?? <SkText w={260} />}</div>}
        </div>
        {controls.length > 0 && <div className="toolbar no-print" aria-hidden="true">{controls.map((w, i) => <span key={i} className="sk sk-ctl" style={{ width: w }} />)}</div>}
      </div>
      {body === 'report' && <><SkCards n={cards} />{ageing && <SkAgeing />}<div className="panel sk-panel"><SkRows n={8} /></div></>}
      {body === 'list' && (
        <div className="panel">
          <div className="panel-body sk-filters" aria-hidden="true">{[240, 200, 150].map((w, i) => <span key={i} className="sk sk-ctl" style={{ width: w }} />)}</div>
          <div className="sk-panel"><SkRows n={10} /></div>
        </div>)}
      {body === 'detail' && (
        <div className="panel">
          <div className="panel-body">
            <div className="sk-kv">{Array.from({ length: 6 }, (_, i) => <div key={i}><div className="sk sk-line w40" /><div className="sk sk-line w70" /></div>)}</div>
          </div>
          <div className="sk-panel"><SkRows n={6} /></div>
        </div>)}
    </div>);
}

export function ErrorNotice({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="notice err" role="alert"><span>✕</span><div style={{ flex: 1 }}>{error.message}</div>{onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}</div>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err'; children: ReactNode }) {
  const sym = kind === 'err' ? '✕' : kind === 'warn' ? '!' : 'i';
  return <div className={`notice ${kind}`}><span aria-hidden="true" style={{ fontWeight: 700 }}>{sym}</span><div>{children}</div></div>;
}

const STATUS: Record<string, [string, string]> = {
  'Paid': ['ok', '✓'], 'Partially paid': ['warn', '½'], 'Unpaid': ['err', '○'], 'Unknown': ['neutral', '?'], 'Not applicable': ['neutral', '–'],
  'Cancelled': ['neutral', '⊘'], 'Optional': ['neutral', '◌'], 'Overdue': ['err', '!'], 'Not due': ['ok', '✓'],
};
export function StatusTag({ status, title }: { status: string; title?: string }) {
  const [cls, sym] = STATUS[status] ?? ['neutral', '•'];
  return <span className={`tag ${cls}`} title={title}><span aria-hidden="true">{sym}</span>{status}</span>;
}

/* ── Long tables: render the first rows, more on request, everything when printing ── */
const FIRST_ROWS = 200;
export interface RowLimit { shown: number; total: number; more: () => void; all: () => void }
/** Rows to render for a list of `total`. Starts again at the first 200 whenever `resetKey` changes (new data or filters). */
export function useRowLimit(total: number, resetKey: unknown): RowLimit {
  const [limit, setLimit] = useState(FIRST_ROWS);
  const [printing, setPrinting] = useState(false);
  useEffect(() => { setLimit(FIRST_ROWS); }, [resetKey]);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));   // must render every row before the print snapshot is taken
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  return { shown: printing ? total : Math.min(limit, total), total, more: () => setLimit(l => l + 500), all: () => setLimit(Number.MAX_SAFE_INTEGER) };
}
/** Long lists read as one sheet: when the end comes near while scrolling, the next rows appear by themselves. */
export function MoreRows({ rows }: { rows: RowLimit }) {
  return <NearEnd active={rows.shown < rows.total} onNear={rows.more} count={rows.shown} />;
}

/**
 * Invisible marker under a list. While `active`, it calls `onNear` whenever it comes within ~a screen of view (so rows
 * are ready before the reader gets there); shows a few placeholder rows while more are loading. Nothing after the last row.
 */
function NearEnd({ active, onNear, count, loading }: { active: boolean; onNear: () => void; count: number; loading?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onNear); cb.current = onNear;
  useEffect(() => {
    const el = ref.current; if (!active || !el) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) cb.current(); }, { rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active, count]);   // re-armed after each batch, so it keeps going while the end is still in view
  if (!active) return null;
  return <div ref={ref} className="load-more no-print">{loading && <Loading rows={3} />}</div>;
}

/** End of a continuous list from useInfiniteApi: loads the next rows while scrolling, until the last one. */
export function LoadMore({ list }: { list: InfiniteList }) {
  return (<>
    <NearEnd active={!list.done && !list.error} onNear={list.loadMore} count={list.rows.length} loading={list.loadingMore} />
    {list.error && list.data && <ErrorNotice error={list.error} onRetry={list.loadMore} />}
  </>);
}

/* ── Column search ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A search button at the right end of a name column's heading (Customer, Creditor…). Pressing it slides a search row
 * open under the header row and puts the cursor in it; typing filters the sheet by that column at once (any part of the
 * name, any case). Pressing the button again (it shows ✕ while open) or Esc slides the row shut and shows every row again.
 * The same look and behaviour on every sheet: DataTable does it for a column with `search`; a hand-built sheet uses
 * useColumnSearch + SearchHeading (inside its <th className="name th-search">) + SearchRow (inside its <thead>). */
export interface ColumnSearch {
  open: boolean; query: string;
  /** The query as matched: lower case, spaces tidied. Empty = no filter. */
  needle: string;
  rowId: string; btn: { current: HTMLButtonElement | null }; input: { current: HTMLInputElement | null };
  setQuery: (q: string) => void; toggle: () => void; close: (refocus?: boolean) => void;
  /** True when the text contains the query (always true with no query). */
  matches: (text: unknown) => boolean;
}
const normText = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Search state of one sheet. Starts closed and empty again whenever `resetKey` changes (another view of the sheet). */
export function useColumnSearch(resetKey: unknown = ''): ColumnSearch {
  const [st, setSt] = useState({ key: resetKey, open: false, query: '' });
  const cur = Object.is(st.key, resetKey) ? st : { key: resetKey, open: false, query: '' };
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const rowId = useId();
  const needle = normText(cur.query);
  const close = (refocus = false) => {
    setSt({ key: resetKey, open: false, query: '' });
    if (refocus) btn.current?.focus({ preventScroll: true });
  };
  const openRow = () => {
    // Commit first so the box is visible, then focus it in the same tap (phones only open the keyboard during the tap).
    flushSync(() => setSt({ key: resetKey, open: true, query: '' }));
    input.current?.focus({ preventScroll: true });
  };
  return {
    open: cur.open, query: cur.query, needle, rowId, btn, input,
    setQuery: q => setSt({ key: resetKey, open: true, query: q }),
    toggle: () => (cur.open ? close() : openRow()), close,
    matches: text => !needle || normText(text).includes(needle),
  };
}

/** Heading text with the search button at its right end. Put it in a <th className="name th-search">. */
export function SearchHeading({ search, label, children }: { search: ColumnSearch; label: string; children: ReactNode }) {
  return (
    <span className="th-inner">
      <span className="th-label">{children}</span>
      <button type="button" ref={search.btn} className="th-search-btn no-print" aria-label={search.open ? `Close ${label.toLowerCase()}` : label}
        aria-expanded={search.open} aria-controls={search.rowId} onClick={e => { e.stopPropagation(); search.toggle(); }}>
        <span className="i-search"><Icon.search /></span><span className="i-close"><Icon.close /></span>
      </button>
    </span>);
}

/** The search row under the header row (always in the table; it slides open and shut). Put it inside the <thead>. */
export function SearchRow({ search, colSpan, placeholder, label }: { search: ColumnSearch; colSpan: number; placeholder: string; label: string }) {
  return (
    <tr className="search-row no-print" id={search.rowId} data-open={search.open || undefined}>
      <td colSpan={colSpan}>
        <div className="search-slide"><div className="search-slide-in"><div className="search-slide-box">
          <input ref={search.input} type="search" className="col-search-input" aria-label={label} placeholder={placeholder} value={search.query}
            autoComplete="off" spellCheck={false} tabIndex={search.open ? undefined : -1}
            onChange={e => search.setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); search.close(true); } }} />
        </div></div></div>
      </td>
    </tr>);
}

/** Row shown in place of the rows when the search matches nothing (the search row stays open above it). */
export function NoMatchRow({ colSpan, what, query }: { colSpan: number; what: string; query: string }) {
  return <tr className="no-match"><td colSpan={colSpan}>No {what} matches “{query.trim()}”.</td></tr>;
}

/** One shared collator: building one per comparison made sorting large tables slow. */
const collator = new Intl.Collator('en-IN', { numeric: true });

export interface Column<R> {
  key: string; label: string; num?: boolean; wrap?: boolean; sortable?: boolean; primary?: boolean; hideSm?: boolean;
  render?: (r: R) => ReactNode; sortValue?: (r: R) => string | number | null; title?: string;
  /** Column alignment. By default every column is centred except name/text columns (see isNameCol), which read from the left. */
  align?: 'left' | 'center';
  /** Fixed column width in px when the standard one does not suit (e.g. a narrow "#" column). See "Column widths" in globals.css. */
  width?: number;
  /** A row may merge this cell with the next N-1 cells (they are left out of that row). */
  span?: (r: R) => number;
  /** Search button in this column's heading (see "Column search"); a string sets the box's placeholder. One column per table. */
  search?: boolean | string;
  /** Text the search looks in (default: sortValue, else the row's field). */
  searchText?: (r: R) => unknown;
}

/** Columns holding names or free text (party, ledger, item, group, account, narration…): left-aligned. Everything else is centred. */
const NAME_KEYS = new Set(['name', 'ledger', 'label', 'item', 'godown', 'party', 'particulars', 'group', 'customer', 'supplier', 'account', 'narration']);
const isNameCol = (c: Column<any>) => c.align ? c.align === 'left' : !!c.wrap || NAME_KEYS.has(c.key);

/** Opens an in-app address: a new tab/window with Ctrl/⌘/Shift or the middle button, otherwise in place (instantly). */
export function useOpen() {
  const navigate = useNavigate();
  return (href: string, e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; button?: number }) => {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1)) window.open(href, '_blank', 'noopener');
    else navigate(href);
  };
}

/**
 * Props that make a hand-built table row open a page, exactly like a DataTable row with `rowHref`: the whole row is the
 * link (no blue link text inside it), a click opens it (new tab with Ctrl/⌘/Shift or the middle button), Enter opens it
 * from the keyboard, and the page preloads when the pointer rests on the row. No href → a plain, non-clickable row.
 *   const rowLink = useRowLink();  <tr {...rowLink(href)}>…</tr>
 */
export function useRowLink() {
  const open = useOpen();
  return (href: string | undefined, className = '') => {
    if (!href) return { className: className || undefined };
    const go = (e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; button?: number }) => open(href, e);
    return {
      className: `clickable${className ? ` ${className}` : ''}`, tabIndex: 0, 'data-href': href, onClick: go,
      onAuxClick: (e: { button: number; preventDefault: () => void }) => { if (e.button === 1) { e.preventDefault(); go(e); } },
      onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') go(e); },
    };
  };
}

/** Rows are one line tall: a cell cut with "…" shows its full text as a tooltip when pointed at. */
const showFullText = (e: { currentTarget: HTMLElement }) => {
  const t = e.currentTarget;
  if (t.scrollWidth > t.clientWidth + 1) t.title = t.textContent ?? ''; else t.removeAttribute('title');
};

/**
 * Accessible, sortable table. On phones it becomes stacked record cards (each cell labelled).
 * `rowHref` makes a row a link to another page: it opens on click (new tab with Ctrl/⌘ or the middle button), and the
 * page and its data start loading as soon as the pointer rests on the row (data-href → shell prefetch), so it opens instantly.
 */
export function DataTable<R>({ columns, rows, rowKey, onRowClick, rowHref, footer, empty = 'Nothing to show for this selection.', caption, initialSort, cardsOnMobile = true, rowClass, search: outerSearch }: {
  columns: Column<R>[]; rows: R[]; rowKey: (r: R, i: number) => string; onRowClick?: (r: R) => void; rowHref?: (r: R) => string | undefined;
  /** Total row(s). As a function it gets the rows on screen and whether a search filters them, so totals can follow the
   *  search; a plain footer is hidden while a search filters the sheet (its totals would not match the rows). */
  footer?: ReactNode | ((shown: R[], filtered: boolean) => ReactNode);
  empty?: string; caption?: string; initialSort?: { key: string; dir: 'asc' | 'desc' }; cardsOnMobile?: boolean; rowClass?: (r: R) => string | undefined;
  /** Search state kept by the page (useColumnSearch), so the search survives opening a row and coming back. Default: the table's own. */
  search?: ColumnSearch;
}) {
  const open = useOpen();
  // Sort and "show more" belong to one view of the table: a tab showing other rows (another caption, columns or default
  // sort) starts fresh instead of inheriting the previous tab's sort.
  const ident = `${caption ?? ''}|${columns.map(c => c.key).join(',')}|${initialSort?.key ?? ''}:${initialSort?.dir ?? ''}`;
  const [sortState, setSortState] = useState({ ident, sort: initialSort });
  const sort = sortState.ident === ident ? sortState.sort : initialSort;
  const setSort = (f: (s: typeof initialSort) => typeof initialSort) => setSortState({ ident, sort: f(sort) });
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    const val = (r: R) => col.sortValue ? col.sortValue(r) : (r as any)[col.key];
    // Read each value once, then sort (decorate–sort–undecorate).
    const keyed = rows.map(r => { const v = val(r); const n = Number(v); return { r, v, n, blank: v === null || v === undefined || v === '' }; });
    const numeric = !!col.num;
    keyed.sort((a, b) => {
      if (a.v === b.v) return 0;
      if (a.blank) return 1;
      if (b.blank) return -1;
      const c = numeric && !isNaN(a.n) && !isNaN(b.n) ? a.n - b.n : collator.compare(String(a.v), String(b.v));
      return sort.dir === 'asc' ? c : -c;
    });
    return keyed.map(k => k.r);
  }, [rows, sort, columns]);
  // Column search: the rows whose searched column contains the query (in the current sort order).
  const searchCol = columns.find(c => c.search);
  const ownSearch = useColumnSearch(ident);
  const search = outerSearch ?? ownSearch;
  const needle = searchCol ? search.needle : '';
  const shownRows = useMemo(() => {
    if (!searchCol || !needle) return sorted;
    const text = (r: R) => searchCol.searchText ? searchCol.searchText(r) : searchCol.sortValue ? searchCol.sortValue(r) : (r as any)[searchCol.key];
    return sorted.filter(r => search.matches(text(r)));
  }, [sorted, searchCol, needle]);   // eslint-disable-line react-hooks/exhaustive-deps
  const limit = useRowLimit(shownRows.length, `${ident}:${rows.length}:${rows.length ? rowKey(rows[0], 0) : ''}:${needle}`);
  if (!rows.length) return <div className="empty">{empty}</div>;
  const foot = typeof footer === 'function' ? (shownRows.length ? footer(shownRows, !!needle) : null) : needle ? null : footer;
  const searchLabel = searchCol && `Search ${searchCol.label.toLowerCase()}`;
  return (
    <div className="table-wrap">
      <table className={`data${cardsOnMobile ? ' cards-sm' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map(c => {
          const label = c.sortable === false ? c.label : (
            <button type="button" onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
              {c.label}
            </button>);
          return (
          <th key={c.key} className={`${c.num ? 'num' : ''}${isNameCol(c) ? ' name' : ''}${c.hideSm ? ' hide-sm' : ''}${c === searchCol ? ' th-search' : ''}`} title={c.title} style={c.width ? { width: c.width } : undefined}
              aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            {c === searchCol ? <SearchHeading search={search} label={searchLabel!}>{label}</SearchHeading> : label}
          </th>);
        })}</tr>
        {searchCol && <SearchRow search={search} colSpan={columns.length} label={searchLabel!}
          placeholder={typeof searchCol.search === 'string' ? searchCol.search : `Search ${searchCol.label.toLowerCase()} name`} />}
        </thead>
        <tbody>
          {needle && !shownRows.length && <NoMatchRow colSpan={columns.length} what={searchCol!.label.toLowerCase()} query={search.query} />}
          {shownRows.slice(0, limit.shown).map((r, i) => {
            const href = rowHref?.(r);
            const act = href ? (e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; button?: number }) => open(href, e) : onRowClick ? () => onRowClick(r) : undefined;
            return (
            <tr key={rowKey(r, i)} className={`${act ? 'clickable' : ''} ${rowClass?.(r) ?? ''}`} data-href={href} onClick={act}
                onAuxClick={href ? e => { if (e.button === 1) { e.preventDefault(); open(href, e); } } : undefined}
                tabIndex={act ? 0 : undefined} onKeyDown={act ? e => { if (e.key === 'Enter') act(e); } : undefined}>
              {columns.map((c, ci) => {
                const hidden = columns.slice(0, ci).some((p, pi) => (p.span?.(r) ?? 1) > ci - pi);   // swallowed by a merged cell on its left
                if (hidden) return null;
                const colSpan = c.span?.(r) ?? 1;
                return (
                <td key={c.key} data-label={c.label} colSpan={colSpan > 1 ? colSpan : undefined} className={`${c.num ? 'num' : ''}${isNameCol(c) ? ' name' : ''}${c.wrap ? ' wrap' : ''}${c.primary ? ' primary-cell' : ''}${c.hideSm ? ' hide-sm' : ''}`}
                    onMouseEnter={showFullText}>
                  {c.render ? c.render(r) : ((r as any)[c.key] ?? '—')}
                </td>);
              })}
            </tr>);
          })}
          {foot}
        </tbody>
      </table>
      <MoreRows rows={limit} />
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;   // one page: nothing to show under the table (no record count)
  return (
    <div className="table-foot">
      <span className="spacer" />
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export function Search({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const [v, setV] = useState(value);
  const last = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (value !== last.current) { last.current = value; setV(value); } }, [value]);   // Back/Forward or a cleared filter
  const commit = (next: string) => { window.clearTimeout(timer.current); if (next !== last.current) { last.current = next; onChange(next); } };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <form role="search" onSubmit={e => { e.preventDefault(); commit(v); }} style={{ display: 'contents' }}>
      <input type="search" className="search-input" aria-label={label} placeholder={placeholder} value={v}
             onChange={e => { const next = e.target.value; setV(next); window.clearTimeout(timer.current);
                              if (next === '') commit(''); else timer.current = window.setTimeout(() => commit(next), 350); }}
             onBlur={() => commit(v)} />
    </form>
  );
}

/** Dr/Cr balance with text label (never colour alone). */
export function Balance({ v }: { v: string | null | undefined }) {
  return <span className="tnum">{drCr(v)}</span>;
}
