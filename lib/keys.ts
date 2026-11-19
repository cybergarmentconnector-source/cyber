/**
 * Every report request URL is built here, by the pages and by the background preloader alike.
 * One source of truth means a preloaded response is exactly the one the page asks for (same cache key).
 */
import { qs } from './qs';
import { balanceDate, defaultPeriod, type CompanyInfo, type Period } from './period';

const co = (cid: string) => `/v1/companies/${cid}`;
type S = string | null | undefined;

export const keys = {
  dashboard: (cid: string, p: Period) => `${co(cid)}/dashboard?${qs({ ...p, asOf: balanceDate(p) })}`,
  spTransactions: (cid: string, side: 'sales' | 'purchases', p: Period, o: { tax: string; returns: string; party?: S; item?: S; q?: S; kind?: S; page?: S }) =>
    `${co(cid)}/${side}/transactions?${qs({ ...p, tax: o.tax, returns: o.returns, party: o.party ?? '', item: o.item ?? '', q: o.q ?? '', kind: o.kind ?? '', page: o.page || '1', pageSize: 50 })}`,
  spSummary: (cid: string, side: 'sales' | 'purchases', p: Period, o: { tax: string; returns: string; groupBy: string; q?: S }) =>
    `${co(cid)}/${side}?${qs({ ...p, tax: o.tax, returns: o.returns, groupBy: o.groupBy, q: o.q })}`,
  flowSummary: (cid: string, flow: 'receipts' | 'payments', p: Period, q?: S) => `${co(cid)}/${flow}?${qs({ ...p, q })}`,
  flowTransactions: (cid: string, flow: 'receipts' | 'payments', p: Period, o: { ledger?: S; allocation?: S; page?: S } = {}) =>
    `${co(cid)}/${flow}/transactions?${qs({ ...p, ledger: o.ledger ?? '', allocation: o.allocation ?? '', page: o.page || '1', pageSize: 50 })}`,
  outstanding: (cid: string, kind: 'receivables' | 'payables', o: { asOf: string; view: string; bucket?: S; overdue?: S; q?: S }) =>
    `${co(cid)}/${kind}?${qs({ asOf: o.asOf, view: o.view, bucket: o.bucket, overdue: o.overdue, q: o.q })}`,
  stock: (cid: string, p: Period, o: { view: string; q?: S; filter?: S; group?: S; category?: S }) =>
    `${co(cid)}/stock?${qs({ ...p, view: o.view, q: o.q, filter: o.filter, group: o.group, category: o.category })}`,
  groups: (cid: string) => `${co(cid)}/groups`,
  syncStatus: (cid: string) => `${co(cid)}/sync-status`,
  voucher: (cid: string, vid: string) => `${co(cid)}/vouchers/${encodeURIComponent(vid)}`,
  ledger: (cid: string, lid: string, p: Period, page?: S) => `${co(cid)}/ledgers/${encodeURIComponent(lid)}?${qs({ ...p, page: page || '1', pageSize: 200 })}`,
  stockItem: (cid: string, itemId: string, p: Period, page?: S) => `${co(cid)}/stock/${encodeURIComponent(itemId)}?${qs({ ...p, page: page || '1' })}`,
  devices: () => '/v1/devices',
};

/** The first requests each menu tab makes with its default view and filters. */
export function tabKeys(cid: string, p: Period): Record<string, string[]> {
  const asOf = balanceDate(p);
  const sp = { tax: 'incl', returns: 'after', groupBy: 'party' };
  return {
    dashboard: [keys.dashboard(cid, p)],
    // Sales / Purchases open on the Customer / Supplier tab: the party totals, and the invoice list for their latest dates.
    sales: [keys.spSummary(cid, 'sales', p, sp), keys.spTransactions(cid, 'sales', p, { ...sp, kind: 'documents' })],        // + invoice dates
    purchases: [keys.spSummary(cid, 'purchases', p, sp), keys.spTransactions(cid, 'purchases', p, { ...sp, kind: 'documents' })],
    receipts: [keys.flowSummary(cid, 'receipts', p), keys.flowTransactions(cid, 'receipts', p)],
    payments: [keys.flowSummary(cid, 'payments', p), keys.flowTransactions(cid, 'payments', p)],
    receivables: [keys.outstanding(cid, 'receivables', { asOf, view: 'ledger' })],
    payables: [keys.outstanding(cid, 'payables', { asOf, view: 'ledger' })],
    stock: [keys.stock(cid, p, { view: 'item' })],
    sync: [keys.syncStatus(cid), keys.devices()],
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * The data a page will ask for when opened at this in-app address, so hovering any link or row can load it beforehand
 * (the page then opens with its figures instead of a placeholder). Empty when it cannot be known from the address alone.
 */
export function routeKeys(u: URL, c: CompanyInfo): string[] {
  const m = /^\/c\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(u.pathname);
  if (!m || decode(m[1]) !== c.id) return [];
  const sp = u.searchParams, from = sp.get('from'), to = sp.get('to');
  const p: Period = from && to && ISO.test(from) && ISO.test(to) ? { from, to } : defaultPeriod(c);
  const [, , section, rawId] = m;
  if (!rawId) {
    // A menu tab in its default view. Any other filter in the address means the page asks for something else.
    if ([...sp.keys()].some(k => k !== 'from' && k !== 'to')) return [];
    return tabKeys(c.id, p)[section] ?? [];
  }
  const id = decode(rawId);
  if (section === 'vouchers') return [keys.voucher(c.id, id)];
  if (section === 'stock') return [keys.stockItem(c.id, id, p, sp.get('page'))];
  return [];
}
