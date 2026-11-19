'use client';
import { useEffect, useMemo } from 'react';
import { useApi, useInfiniteApi } from '@/lib/api';
import { PageHead, PrintButton, usePeriod, useCompany, useQuery, cpath } from './shell';
import { Card, ErrorNotice, LoadMore, Loading, NoMatchRow, SearchHeading, SearchRow, money, rupees, formatDate, useColumnSearch, useOpen } from './ui';
import { MonthlyBars, HEX } from './charts';
import { keys } from '@/lib/keys';

export function CashFlow({ flow }: { flow: 'receipts' | 'payments' }) {
  const { company } = useCompany();
  const cid = company.id;
  const [period, setPeriod] = usePeriod();
  const { get, set } = useQuery();
  const openHref = useOpen();
  const R = flow === 'receipts';
  const T = R ? { title: 'Receipts', party: 'Customer', color: HEX.receipts } : { title: 'Payments', party: 'Creditor', color: HEX.payments };
  const sum = useApi<any>(keys.flowSummary(cid, flow, period, ''));
  const allocation = get('allocation');
  // One sheet (no tabs): every receipt / payment — Date · Customer (Creditor) · Invoice no. · Amount — loading more
  // rows while scrolling. The Advances card filters it (click again to show all).
  const tx = useInfiniteApi<any>(pg => keys.flowTransactions(cid, flow, period, { ledger: get('ledger'), allocation, page: String(pg) }));
  const s = sum.data;
  const txRows: any[] = tx.rows;
  // Customer / Creditor search (button in that heading, same as every sheet). The sheet loads its rows while scrolling, so a
  // search first loads the rest of the period's rows in the background (a few pages at a time) and matches them all; a few
  // placeholder rows show under the matches until every row is in. The total then adds up the matching rows.
  const search = useColumnSearch(flow);
  const needle = search.needle;
  useEffect(() => { if (needle && tx.data && !tx.done) tx.loadAll(); }, [needle, tx.data, tx.done]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => needle ? txRows.filter(r => search.matches(r.ledger)) : txRows, [txRows, needle]);   // eslint-disable-line react-hooks/exhaustive-deps
  const searching = !!needle && !tx.done && !tx.error;
  const shownTotal = String(shown.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0) / 100);
  const searchLabel = `Search ${T.party.toLowerCase()}`;
  const toggle = (a: string) => set({ allocation: allocation === a ? null : a });
  const open = (r: any, e: any) => openHref(cpath(cid, `vouchers/${r.id}`), e);

  return (
    <>
      <PageHead title={T.title} period={{ value: period, onChange: setPeriod }}>
        <PrintButton />
      </PageHead>
      <ErrorNotice error={sum.error} onRetry={sum.reload} />
      {sum.loading && !s ? <Loading page cards={2} /> : s && (<>
        <div className="cards">
          <Card label={`Total ${T.title.toLowerCase()}`} value={rupees(s.total)} detail={`${s.vouchers} voucher${s.vouchers === 1 ? '' : 's'}`} />
          <Card label="Advances" value={rupees(s.advance)} detail="Allocated as advance bills" selected={allocation === 'advance'} onClick={() => toggle('advance')} />
        </div>
        <section className="panel">
          <div className="panel-head"><h2>{T.title} by month</h2></div>
          <div className="panel-body">
            <MonthlyBars title={`${T.title} by month`} data={s.monthly.map((m: any) => ({ month: m.month, value: m.amount }))} series={[{ key: 'value', label: T.title, color: T.color }]} />
          </div>
        </section>
      </>)}
      <section className="panel">
        <ErrorNotice error={tx.error} onRetry={tx.reload} />
        {tx.loading && !tx.data ? <Loading /> : tx.data && (txRows.length === 0 ? <div className="empty">No {T.title.toLowerCase()} for this selection.</div> : <>
          <div className="table-wrap">
            <table className="data cards-sm">
              <caption className="sr-only">{T.title}</caption>
              <thead>
                <tr><th>Date</th><th className="name th-search"><SearchHeading search={search} label={searchLabel}>{T.party}</SearchHeading></th><th>Invoice no.</th><th className="num">Amount</th></tr>
                <SearchRow search={search} colSpan={4} label={searchLabel} placeholder={`Search ${T.party.toLowerCase()} name`} />
              </thead>
              <tbody>
                {needle && !searching && shown.length === 0 && <NoMatchRow colSpan={4} what={T.party.toLowerCase()} query={search.query} />}
                {shown.map(r => (
                <tr key={`${r.id}:${r.line}`} className="clickable" tabIndex={0} data-href={cpath(cid, `vouchers/${r.id}`)} onClick={e => open(r, e)}
                    onAuxClick={e => { if (e.button === 1) { e.preventDefault(); open(r, e); } }} onKeyDown={e => e.key === 'Enter' && open(r, e)}>
                  <td data-label="Date">{formatDate(r.date)}</td>
                  <td data-label={T.party} className="name primary-cell">{r.ledger}</td>
                  <td data-label="Invoice no.">{r.voucherNumber ?? '—'}</td>
                  <td data-label="Amount" className="num"><b>{money(r.amount)}</b></td>
                </tr>))}
                {tx.done && shown.length > 0 && <tr className="total foot"><td colSpan={3} className="primary-cell">Total</td><td className="num total-main" data-label="Amount">{money(needle ? shownTotal : tx.data.totals.amount)}</td></tr>}
              </tbody>
            </table>
          </div>
          {needle ? (searching && <Loading rows={3} />) : <LoadMore list={tx} />}
        </>)}
      </section>
    </>
  );
}
