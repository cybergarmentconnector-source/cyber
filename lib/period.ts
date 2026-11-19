import { formatDate } from './money';

export interface Period { from: string; to: string }
export interface CompanyInfo {
  id: string; name: string; booksFrom: string | null; fyStartMonth: number; baseCurrency: string;
  lastPublishedAt: string | null; lastAttemptAt: string | null; lastError: string | null;
  /** Changes only when the report data changed (cache key); older servers do not send it. */
  dataVersion?: string | null;
  firstVoucherDate: string | null; lastVoucherDate: string | null; syncIntervalSec: number; lastRunStatus: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => iso(new Date());

export function fyOf(date: string, startMonth = 4): Period {
  const [y, m] = date.split('-').map(Number);
  const sy = m >= startMonth ? y : y - 1;
  return { from: `${sy}-${pad(startMonth)}-01`, to: iso(new Date(sy + 1, startMonth - 1, 0)) };
}

export const fyLabel = (p: Period) => `FY ${p.from.slice(0, 4)}–${p.to.slice(2, 4)}`;

/** Financial years from books-beginning to the year of the latest voucher (or today). */
export function financialYears(c: CompanyInfo): Period[] {
  const start = c.booksFrom ?? c.firstVoucherDate ?? todayIso();
  const end = [c.lastVoucherDate, todayIso()].filter(Boolean).sort().pop()!;
  const out: Period[] = [];
  let p = fyOf(start, c.fyStartMonth);
  const last = fyOf(end, c.fyStartMonth);
  while (p.from <= last.from && out.length < 30) { out.push(p); p = fyOf(addDays(p.to, 1), c.fyStartMonth); }
  return out.reverse();
}

export function addDays(d: string, n: number) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return iso(x); }

export function defaultPeriod(c: CompanyInfo): Period {
  return fyOf(c.lastVoucherDate ?? todayIso(), c.fyStartMonth);
}

export function presets(c: CompanyInfo): { key: string; label: string; period: Period }[] {
  const t = todayIso();
  const [y, m] = t.split('-').map(Number);
  const monthStart = `${y}-${pad(m)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const q = Math.floor(((m - c.fyStartMonth + 12) % 12) / 3);
  const fy = fyOf(t, c.fyStartMonth);
  const qStart = (() => { const d = new Date(fy.from + 'T00:00:00'); d.setMonth(d.getMonth() + q * 3); return iso(d); })();
  return [
    { key: 'this-month', label: 'This month', period: { from: monthStart, to: t } },
    { key: 'last-month', label: 'Last month', period: { from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd } },
    { key: 'this-quarter', label: 'This quarter', period: { from: qStart, to: t } },
    { key: 'fy-to-date', label: 'FY to date', period: { from: fy.from, to: t } },
  ];
}

export const periodText = (p: Period) => `${formatDate(p.from)} – ${formatDate(p.to)}`;
export const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y.slice(2)}`; };
export const monthRange = (ym: string): Period => { const [y, m] = ym.split('-').map(Number); return { from: `${ym}-01`, to: iso(new Date(y, m, 0)) }; };

/** Freshness classification — docs/SYNC_PROTOCOL.md §6. */
export function freshness(c: CompanyInfo): { state: 'fresh' | 'stale' | 'failed' | 'never'; label: string } {
  if (!c.lastPublishedAt) return { state: 'never', label: 'Not synced yet' };
  const age = Date.now() - new Date(c.lastPublishedAt).getTime();
  if (c.lastRunStatus === 'failed' && c.lastError) return { state: 'failed', label: 'Last sync failed' };
  if (age > Math.max(3 * (c.syncIntervalSec || 300) * 1000, 15 * 60_000)) return { state: 'stale', label: 'Stale' };
  return { state: 'fresh', label: 'Up to date' };
}

export function syncedText(ts: string | null) {
  if (!ts) return 'Never synced';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}

/** Balance date for a period: its end, or today if the period has not ended yet. */
export const balanceDate = (p: Period) => (p.to > todayIso() ? todayIso() : p.to);
