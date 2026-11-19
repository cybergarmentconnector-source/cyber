'use client';
import { CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatDate } from '@/lib/money';

/* Shared dropdown popups for the whole site: <Select> (replaces <select>) and <DatePicker> (replaces <input type="date">).
   Both render their popup in a portal with fixed positioning, so no panel, table or card can clip them. */

const svg = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', 'aria-hidden': true };
const Chevron = () => <svg {...svg}><path d="m6 9 6 6 6-6" /></svg>;
const Tick = () => <svg {...svg}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
const CalIcon = () => <svg {...svg}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
const Left = () => <svg {...svg}><path d="m15 6-6 6 6 6" /></svg>;
const Right = () => <svg {...svg}><path d="m9 6 6 6-6 6" /></svg>;
const Left2 = () => <svg {...svg}><path d="m12 6-6 6 6 6M19 6l-6 6 6 6" /></svg>;
const Right2 = () => <svg {...svg}><path d="m12 6 6 6-6 6M5 6l6 6-6 6" /></svg>;

/** `hint` = a short grey note shown next to the option in the menu only (the button shows just the label). */
export type SelectOption = { value: string; label: string; hint?: string };
export type SelectGroup = { group: string; options: SelectOption[] };
export type SelectItem = SelectOption | SelectGroup;
const isGroup = (i: SelectItem): i is SelectGroup => 'group' in i;

/** Places a popup under (or, when short of room, above) its trigger and keeps it on screen. */
function usePopupPosition(open: boolean, trigger: React.RefObject<HTMLElement | null>, pop: React.RefObject<HTMLElement | null>, minWidth?: number) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !pop.current) return;
    const r = trigger.current.getBoundingClientRect();
    const w = Math.max(pop.current.offsetWidth, r.width, minWidth ?? 0);
    const roomBelow = window.innerHeight - r.bottom - 12, roomAbove = r.top - 12;
    const up = roomBelow < 220 && roomAbove > roomBelow;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setStyle({
      left, minWidth: Math.max(r.width, minWidth ?? 0), visibility: 'visible',
      ...(up ? { bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(340, roomAbove) } : { top: r.bottom + 4, maxHeight: Math.min(340, roomBelow) }),
    });
  }, [open, trigger, pop, minWidth]);
  return style;
}

/** Closes on outside click, Escape, resize, or scrolling of the page behind the popup. */
function useDismiss(open: boolean, close: (refocus: boolean) => void, refs: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => refs.some(r => r.current && t instanceof Node && r.current.contains(t));
    const down = (e: PointerEvent) => { if (!inside(e.target)) close(false); };
    const scroll = (e: Event) => { if (!inside(e.target)) close(false); };
    const resize = () => close(false);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [open, close, refs]);
}

export function Select({ value, onChange, options, ariaLabel, id, style, className, display }: {
  value: string; onChange: (v: string) => void; options: SelectItem[]; ariaLabel?: string; id?: string; style?: CSSProperties; className?: string;
  /** What the trigger shows instead of the chosen option's label (e.g. the period's dates). */
  display?: ReactNode;
}) {
  const uid = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);
  const typed = useRef({ s: '', t: 0 });

  const flat = useMemo(() => options.flatMap(i => isGroup(i) ? i.options : [i]), [options]);
  const searchable = flat.length > 10;
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return options;
    return options.map(i => isGroup(i) ? { ...i, options: i.options.filter(o => o.label.toLowerCase().includes(f)) } : i)
      .filter(i => isGroup(i) ? i.options.length > 0 : i.label.toLowerCase().includes(f));
  }, [options, q]);
  const visible = useMemo(() => shown.flatMap(i => isGroup(i) ? i.options : [i]), [shown]);
  const current = flat.find(o => o.value === value);

  const close = useCallback((refocus: boolean) => { setOpen(false); setQ(''); if (refocus) btn.current?.focus(); }, []);
  const pick = (v: string) => { close(true); if (v !== value) onChange(v); };
  const style_ = usePopupPosition(open, btn, pop);
  useDismiss(open, close, useMemo(() => [btn, pop], []));

  const openList = () => { setActive(Math.max(0, visible.findIndex(o => o.value === value))); setOpen(true); };
  useEffect(() => { if (open) (searchable ? search.current : pop.current)?.focus({ preventScroll: true }); }, [open, searchable]);
  useEffect(() => { if (open) setActive(a => (a >= visible.length ? 0 : a)); }, [visible.length, open]);
  useEffect(() => { if (open) pop.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const onBtnKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const n = visible.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % Math.max(n, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + n) % Math.max(n, 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (visible[active]) pick(visible[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {      // type-ahead on short lists
      const now = Date.now(); const t = typed.current;
      t.s = now - t.t > 700 ? e.key.toLowerCase() : t.s + e.key.toLowerCase(); t.t = now;
      const i = visible.findIndex(o => o.label.toLowerCase().startsWith(t.s));
      if (i >= 0) setActive(i);
    }
  };

  let idx = -1;
  const row = (o: SelectOption) => {
    idx += 1; const i = idx;
    return (
      <div key={o.value} id={`${uid}-${i}`} role="option" className="opt" aria-selected={o.value === value} data-active={i === active}
        onPointerMove={() => active !== i && setActive(i)} onClick={() => pick(o.value)}>
        <span className="opt-label">{o.label}{o.hint && <span className="opt-hint">{o.hint}</span>}</span>{o.value === value && <span className="tick"><Tick /></span>}
      </div>
    );
  };

  return (
    <span className={`sel${className ? ' ' + className : ''}`} style={style}>
      <button ref={btn} id={id} type="button" className="sel-btn" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? close(false) : openList())} onKeyDown={onBtnKey}>
        <span className="lbl">{display ?? current?.label ?? '—'}</span><Chevron />
      </button>
      {open && createPortal(
        <div ref={pop} className="pop-list" style={style_} tabIndex={-1} onKeyDown={onListKey} role="presentation">
          {searchable && <input ref={search} className="pop-search" type="search" placeholder="Search…" aria-label="Filter options" value={q} onChange={e => { setQ(e.target.value); setActive(0); }} />}
          <div role="listbox" aria-label={ariaLabel} aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}>
            {shown.map(i => isGroup(i)
              ? <div key={i.group} role="group" aria-label={i.group}><div className="grp">{i.group}</div>{i.options.map(row)}</div>
              : row(i))}
            {visible.length === 0 && <div className="opt-none">No matches</div>}
          </div>
        </div>, document.body)}
    </span>
  );
}

/* ---------- date picker ---------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const parse = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return { y, m: m - 1, d }; };
const addDays = (iso: string, n: number) => { const p = parse(iso); return toIso(p.y, p.m, p.d + n); };
const addMonths = (iso: string, n: number) => { const p = parse(iso); const last = new Date(Date.UTC(p.y, p.m + n + 1, 0)).getUTCDate(); return toIso(p.y, p.m + n, Math.min(p.d, last)); };
const today = () => { const t = new Date(); return toIso(t.getFullYear(), t.getMonth(), t.getDate()); };

/** `plain` = shown as grey text with a small chevron (like the period under a page title) instead of a bordered button; `prefix` goes before the date. */
export function DatePicker({ value, onChange, min, max, ariaLabel, plain, prefix }: { value: string; onChange: (iso: string) => void; min?: string; max?: string; ariaLabel?: string; plain?: boolean; prefix?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(value);          // the day the keyboard is on; its month is the one shown
  const ok = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  const style = usePopupPosition(open, btn, pop, 288);
  useDismiss(open, close, useMemo(() => [btn, pop], []));
  useEffect(() => { if (open) pop.current?.querySelector<HTMLElement>('button[data-focus="true"]')?.focus({ preventScroll: true }); }, [open, focus]);

  const f = parse(focus);
  const first = new Date(Date.UTC(f.y, f.m, 1)).getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => toIso(f.y, f.m, i - first + 1));
  const t = today();
  const pick = (iso: string) => { if (!ok(iso)) return; onChange(iso); close(true); };
  const go = (iso: string) => setFocus(iso);

  const onKey = (e: React.KeyboardEvent) => {
    const step: Record<string, string> = {
      ArrowLeft: addDays(focus, -1), ArrowRight: addDays(focus, 1), ArrowUp: addDays(focus, -7), ArrowDown: addDays(focus, 7),
      PageUp: addMonths(focus, e.shiftKey ? -12 : -1), PageDown: addMonths(focus, e.shiftKey ? 12 : 1),
    };
    if (e.key in step) { e.preventDefault(); go(step[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); go(addDays(focus, -new Date(Date.UTC(f.y, f.m, f.d)).getUTCDay())); }
    else if (e.key === 'End') { e.preventDefault(); go(addDays(focus, 6 - new Date(Date.UTC(f.y, f.m, f.d)).getUTCDay())); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <span className={`sel date${plain ? ' sel-text' : ''}`}>
      <button ref={btn} type="button" className="sel-btn" aria-label={`${ariaLabel ?? 'Date'}: ${formatDate(value)}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { if (open) close(false); else { setFocus(value); setOpen(true); } }}>
        <span className={`lbl${plain ? '' : ' tnum'}`}>{prefix}{formatDate(value)}</span>{plain ? <Chevron /> : <CalIcon />}
      </button>
      {open && createPortal(
        <div ref={pop} className="pop-list cal" style={style} role="dialog" aria-label={`Choose ${ariaLabel?.toLowerCase() ?? 'date'}`} onKeyDown={onKey}>
          <div className="cal-head">
            <button type="button" className="cal-nav" aria-label="Previous year" onClick={() => go(addMonths(focus, -12))}><Left2 /></button>
            <button type="button" className="cal-nav" aria-label="Previous month" onClick={() => go(addMonths(focus, -1))}><Left /></button>
            <div className="cal-title" aria-live="polite">{MONTHS[f.m]} {f.y}</div>
            <button type="button" className="cal-nav" aria-label="Next month" onClick={() => go(addMonths(focus, 1))}><Right /></button>
            <button type="button" className="cal-nav" aria-label="Next year" onClick={() => go(addMonths(focus, 12))}><Right2 /></button>
          </div>
          <div className="cal-grid" role="grid">
            {DOW.map(d => <div key={d} className="cal-dow" role="columnheader">{d}</div>)}
            {cells.map(iso => {
              const p = parse(iso), other = p.m !== f.m;
              return (
                <button key={iso} type="button" role="gridcell" className={`cal-day${other ? ' other' : ''}${iso === t ? ' today' : ''}`}
                  aria-selected={iso === value} aria-label={formatDate(iso)} disabled={!ok(iso)} tabIndex={iso === focus ? 0 : -1} data-focus={iso === focus}
                  onClick={() => pick(iso)}>{p.d}</button>
              );
            })}
          </div>
          <div className="cal-foot">
            <button type="button" className="cal-link" disabled={!ok(t)} onClick={() => pick(t)}>Today</button>
          </div>
        </div>, document.body)}
    </span>
  );
}

/**
 * A card (or any button) that opens a small popup for a number of days: a box, quick picks, Cancel / Apply.
 * Enter applies, Escape cancels, a click outside closes it. Only whole numbers ≥ 0 can be typed.
 * The popup lines up with the trigger's right edge (the card sits at the end of a row) and always stays inside the window.
 */
export function DaysPicker({ value, onApply, title, sub, quick = [30, 45, 90, 180], className, selected, ariaLabel, children }: {
  value: number | null; onApply: (days: number) => void; title: string; sub?: string; quick?: number[];
  className?: string; selected?: boolean; ariaLabel?: string; children: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  useDismiss(open, close, useMemo(() => [btn, pop], []));
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) { setStyle({ visibility: 'hidden' }); return; }
    const r = btn.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = pop.current.offsetWidth, h = pop.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    const below = r.bottom + 6 + h <= vh - 8 || r.top - 6 - h < 8;
    setStyle({ left, top: below ? r.bottom + 6 : r.top - 6 - h, visibility: 'visible' });
  }, [open]);
  useEffect(() => { if (open) { input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [open]);
  const apply = (d: number) => { onApply(d); close(true); };
  const typed = /^\d{1,5}$/.test(text) ? Number(text) : null;

  return (
    <>
      <button ref={btn} type="button" className={className} data-selected={selected || undefined} aria-pressed={selected}
        aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => { if (open) close(false); else { setText(value === null ? '' : String(value)); setOpen(true); } }}>
        {children}
      </button>
      {open && createPortal(
        <div ref={pop} className="days-pop" style={style} role="dialog" aria-label={title}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}>
          <div className="days-head">
            <div className="days-title">{title}</div>
            {sub && <div className="days-sub">{sub}</div>}
          </div>
          <label className="days-field">
            <input ref={input} type="text" inputMode="numeric" aria-label="Days" value={text} placeholder="0" size={5}
              onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onKeyDown={e => { if (e.key === 'Enter' && typed !== null) { e.preventDefault(); apply(typed); } }} />
            <span>days</span>
          </label>
          {quick.length > 0 && <div className="days-quick" role="group" aria-label="Quick picks">
            {quick.map(d => <button key={d} type="button" aria-pressed={typed === d} onClick={() => setText(String(d))}>{d} days</button>)}
          </div>}
          <div className="days-actions">
            <button type="button" className="btn sm" onClick={() => close(true)}>Cancel</button>
            <button type="button" className="btn primary sm" disabled={typed === null} onClick={() => typed !== null && apply(typed)}>Apply</button>
          </div>
        </div>, document.body)}
    </>
  );
}
