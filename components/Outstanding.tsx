'use client';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, fetchCached, useApi } from '@/lib/api';
import { balanceDate } from '@/lib/period';
import { AGE_FILTERS, AgeKey, AgedBill, matchesAge, openInvoices, parseDays, sumBalance } from '@/lib/ageing';
import { AsOfSub, PageHead, PrintButton, usePeriod, useCompany, useQuery, qs, cpath } from './shell';
import { ErrorNotice, InfoBox, Loading, MoreRows, NoMatchRow, SearchHeading, SearchRow, money, rupees, formatDate, useColumnSearch, useRowLimit, useRowLink } from './ui';
import { DaysPicker } from './pickers';
import { keys } from '@/lib/keys';

const billsKey = (cid: string, kind: string, lid: string, asOf: string) => `/v1/companies/${cid}/${kind}/${lid}?${qs({ asOf })}`;

/**
 * Every bill-wise party's bills on the as-of date (the same requests the Sales / Purchases info box uses, so they
 * share the cache), a few at a time. While a new as-of date loads, the previous figures stay on screen.
 */
function useAllBills(cid: string, kind: string, asOf: string, ids: string[] | null) {
  const key = ids ? `${cid}|${kind}|${asOf}|${ids.join(',')}` : null;
  const [nonce, setNonce] = useState(0);
  const [st, setSt] = useState<{ key: string | null; asOf: string; bills: Record<string, any[]> | null; error: ApiError | null; loading: boolean }>(
    { key: null, asOf, bills: null, error: null, loading: true });
  useEffect(() => {
    if (!key || !ids) return;
    let live = true, next = 0;
    const out: Record<string, any[]> = {};
    setSt(s => ({ ...s, error: null, loading: true }));
    const worker = async () => {
      while (live && next < ids.length) {
        const lid = ids[next++];
        const d = await fetchCached<any>(billsKey(cid, kind, lid, asOf));
        out[lid] = d?.bills ?? [];
      }
    };
    Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker))
      .then(() => { if (live) setSt({ key, asOf, bills: out, error: null, loading: false }); })
      .catch(e => { if (live) setSt(s => ({ ...s, error: e instanceof ApiError ? e : new ApiError(0, 'network', 'Could not reach the server. Check your connection.'), loading: false })); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  // `asOf` = the date the bills on screen belong to (the previous one while a new date loads).
  return { bills: st.bills, asOf: st.asOf, current: st.key === key, error: st.error, loading: st.loading || st.key !== key, reload: () => setNonce(n => n + 1) };
}

export function Outstanding({ kind }: { kind: 'receivables' | 'payables' }) {
  const { company } = useCompany();
  const cid = company.id;
  const [period] = usePeriod();
  const { get, set } = useQuery();
  const asOf = get('asOf', balanceDate(period));
  const R = kind === 'receivables';
  const T = R ? { title: 'Receivables', who: 'Customer', paid: 'Received' } : { title: 'Payables', who: 'Customer', paid: 'Paid' };

  // Invoice-age filter (one at a time): All outstanding, More than 60 days, More than 120 days, or Custom (> N days).
  const ageParam = get('age', 'all') as AgeKey;
  const age: AgeKey = AGE_FILTERS.some(a => a.key === ageParam) ? ageParam : 'all';
  const customDays = parseDays(get('days'));
  const minOf = (k: AgeKey) => k === 'custom' ? customDays : AGE_FILTERS.find(a => a.key === k)!.min;
  const min = minOf(age);
  const ageLabel = age === 'custom' ? (customDays === null ? 'Custom' : `More than ${customDays} days`) : AGE_FILTERS.find(a => a.key === age)!.label;

  // The party list (names, bill-wise or not), then every bill-wise party's bills for invoice-level figures.
  const sum = useApi<any>(keys.outstanding(cid, kind, { asOf, view: 'ledger' }));
  const billWise: any[] = useMemo(() => (sum.data?.parties ?? []).filter((p: any) => p.isBillWise), [sum.data]);
  const all = useAllBills(cid, kind, asOf, sum.data ? billWise.map(p => String(p.ledgerId)) : null);

  // Each party's open invoices (positive balance on the as-of date), aged from the invoice date.
  const invoices = useMemo(() => all.bills ? billWise.map(p => ({ p, bills: openInvoices(all.bills![p.ledgerId], all.asOf) })) : null,
    [all.bills, billWise, all.asOf]);
  const cardTotal = (k: AgeKey) => invoices ? sumBalance(invoices.flatMap(x => x.bills.filter(b => matchesAge(b, minOf(k))))) : 0;
  const rows = useMemo(() => (invoices ?? [])
    .map(({ p, bills }) => {
      const m = bills.filter(b => matchesAge(b, min));
      return { p, bills: m, amount: sumBalance(m), maxOverdue: Math.max(0, ...m.map(b => b.overdueDays)) };
    })
    .filter(r => r.bills.length > 0)
    .sort((a, b) => b.amount - a.amount), [invoices, min]);
  // Customer search (button in the Customer heading): filters the list by name; kept while a customer is opened and closed.
  const search = useColumnSearch(kind);
  const shown = useMemo(() => search.needle ? rows.filter(r => search.matches(r.p.party)) : rows, [rows, search.needle]);   // eslint-disable-line react-hooks/exhaustive-deps
  const total = { bills: shown.reduce((n, r) => n + r.bills.length, 0), amount: shown.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100 };

  // One customer open at a time: the page then shows only that customer and their invoices; clicking it again goes back to the list.
  const [open, setOpen] = useState<string | null>(null);
  const rowsLimit = useRowLimit(shown.length, `${kind}|${asOf}|${age}|${customDays}|${search.needle}`);
  const toggle = (k: string) => { setOpen(o => o === k ? null : k); window.scrollTo({ top: 0 }); };
  const opened = open === null ? null : rows.find(r => r.p.ledgerId === open) ?? null;   // gone from this filter → back to the list
  // The custom days stay in the Custom card when another card is picked, so going back to Custom keeps them.
  const pick = (k: AgeKey) => set({ age: k === 'all' ? null : k });
  const loading = (sum.loading && !sum.data) || !invoices;
  const error = sum.error ?? all.error;

  return (
    <>
      <PageHead title={T.title} sub={<AsOfSub asOf={asOf} onChange={d => set({ asOf: d })} />}>
        <PrintButton />
      </PageHead>
      <ErrorNotice error={error} onRetry={() => { sum.reload(); all.reload(); }} />
      {loading ? (!error && <Loading page cards={0} ageing />) : (<div className={all.current ? undefined : 'is-stale'}>
        <div className="ageing" role="group" aria-label="Outstanding invoices by age (from the invoice date)">
          {AGE_FILTERS.map(a => {
            const on = age === a.key;
            const v = a.key === 'custom' && customDays === null ? null : cardTotal(a.key);
            const tick = on && <span className="age-tick" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 8.5l2.6 2.6L12 5.6" /></svg></span>;
            const value = <div className="v">{v === null ? <span className="age-hint">Set days</span> : rupees(String(v))}</div>;
            // Custom: a click opens a small popup to enter the days; Apply selects the card with them.
            if (a.key === 'custom') return (
              <DaysPicker key={a.key} className="age-card" selected={on} value={customDays} title="Custom age" sub="Show invoices older than"
                ariaLabel={customDays === null ? 'Custom: set the number of days' : `More than ${customDays} days (change)`}
                onApply={d => set({ age: 'custom', days: String(d) })}>
                {tick}<div className="k">{customDays === null ? 'Custom' : `More than ${customDays} days`}</div>{value}
              </DaysPicker>);
            return (
              <button key={a.key} type="button" className="age-card" data-selected={on || undefined} aria-pressed={on} onClick={() => pick(a.key)}>
                {tick}<div className="k">{a.label}</div>{value}
              </button>);
          })}
        </div>
        {(() => {
          const searchLabel = `Search ${T.who.toLowerCase()}`;
          const head = (withSearch: boolean) => (
            <thead>
              <tr>
                <th className={`name${withSearch ? ' th-search' : ''}`}>{withSearch ? <SearchHeading search={search} label={searchLabel}>{T.who}</SearchHeading> : T.who}</th>
                <th className="num">Max overdue</th><th className="num">Bills</th><th className="num">Amount</th>
              </tr>
              {withSearch && <SearchRow search={search} colSpan={4} label={searchLabel} placeholder={`Search ${T.who.toLowerCase()} name`} />}
            </thead>);
          if (rows.length === 0) return (
            <section className="panel"><div className="table-wrap"><table className="data cards-sm">{head(false)}
              <tbody><tr><td colSpan={4} className="empty">No outstanding invoices for this selection.</td></tr></tbody></table></div></section>);
          const row = ({ p, bills, amount, maxOverdue }: (typeof rows)[number]) => (
            <tr key={p.ledgerId} className="clickable" tabIndex={0} aria-expanded={open === p.ledgerId} onClick={() => toggle(p.ledgerId)}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(p.ledgerId))}>
              <td className="name wrap" data-label={T.who}>
                {p.party}
                
              </td>
              <td className="num" data-label="Max overdue">{maxOverdue > 0 ? `${maxOverdue} days` : 'Not due'}</td>
              <td className="num" data-label="Bills">{bills.length}</td>
              <td className="num" data-label="Amount"><b>{money(String(amount))}</b></td>
            </tr>);
          // An opened customer: their info box (click it to go back to the list), then their invoices as a separate card.
          if (opened) return (<>
            <InfoBox caption={`${T.title} as of ${asOf}: ${opened.p.party}`} expanded onClick={() => toggle(opened.p.ledgerId)} cells={[
              // Same columns and formats as the Sales / Purchases info box: Customer · Invoices · Max due (days) · Amount.
              { label: T.who, value: <>{opened.p.party}</> },
              { label: 'Invoices', value: opened.bills.length },
              { label: 'Max due', value: opened.maxOverdue > 0 ? opened.maxOverdue : '—' },
              { label: 'Amount', value: money(String(opened.amount)), strong: true },
            ]} />
            <section className="panel"><AgedInvoices cid={cid} bills={opened.bills} /></section>
          </>);
          return (
            <section className="panel">
              <div className="table-wrap">
                <table className="data cards-sm">
                  <caption className="sr-only">{T.title} as of {asOf}: {ageLabel}</caption>
                  {head(true)}
                  <tbody>
                    {shown.length === 0 && <NoMatchRow colSpan={4} what={T.who.toLowerCase()} query={search.query} />}
                    {shown.slice(0, rowsLimit.shown).map(row)}
                    {shown.length > 0 && rowsLimit.shown >= shown.length && (
                      <tr className="total foot"><td colSpan={2} className="primary-cell">Total</td><td className="num" data-label="Bills">{total.bills}</td><td className="num total-main" data-label="Amount">{money(String(total.amount))}</td></tr>)}
                  </tbody>
                </table>
              </div>
              <MoreRows rows={rowsLimit} />
            </section>);
        })()}
      </div>)}
    </>
  );
}

/** A bill carried in from the opening balance in Tally (no invoice behind it, e.g. "OB/3"). */
const isOpeningBill = (b: AgedBill) => !!b.isOpening || !b.voucherId;

/** A customer's invoices for the selected age filter: Date · Invoice no. · Days (invoice date to the as-of date) · Amount.
 *  The invoice number is plain text like every sheet; a click on the row opens the invoice. A bill from the opening
 *  balance is shown like the opening row of every party sheet: a pure-white, bold "Opening balance" row (not clickable). */
function AgedInvoices({ cid, bills }: { cid: string; bills: AgedBill[] }) {
  const rowLink = useRowLink();
  return (
    <div className="table-wrap">
      <table className="data cards-sm">
        <thead><tr><th>Date</th><th>Invoice no.</th><th className="num">Days</th><th className="num">Amount</th></tr></thead>
        <tbody>{bills.map(b => (
          <tr key={`${b.bill}|${b.billDate}`} {...(isOpeningBill(b) ? { className: 'opening-row' } : rowLink(b.voucherId ? cpath(cid, `vouchers/${b.voucherId}`) : undefined))}>
            <td data-label="Date">{b.billDate ? formatDate(b.billDate) : '—'}</td>
            <td data-label="Invoice no." className="primary-cell">{isOpeningBill(b) ? 'Opening balance' : b.bill}</td>
            <td className="num" data-label="Days">{b.age ?? '—'}</td>
            <td className="num" data-label="Amount"><b>{money(String(b.balance))}</b></td>
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}
