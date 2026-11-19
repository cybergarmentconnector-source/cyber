'use client';
import { useEffect } from 'react';
import { prefetchApi, useApi, useInfiniteApi } from '@/lib/api';
import { balanceDate, monthRange } from '@/lib/period';
import { openInvoices } from '@/lib/ageing';
import { PageHead, PrintButton, usePeriod, useCompany, useQuery, qs, cpath } from './shell';
import { Balance, Card, DataTable, ErrorNotice, InfoBox, LoadMore, Loading, SkText, Notice, TabPanel, money, rupees, formatDate, formatQty, useColumnSearch, Column } from './ui';
import { MonthlyBars, HEX } from './charts';
import { Select } from './pickers';
import { keys } from '@/lib/keys';

type View = 'party' | 'month' | 'item' | 'transactions';

export function SalesPurchases({ side }: { side: 'sales' | 'purchases' }) {
  const { company } = useCompany();
  const cid = company.id;
  const [period, setPeriod] = usePeriod();
  const { get, set } = useQuery();
  const tax = get('tax', 'incl') as 'incl' | 'excl';
  const returns = 'after' as 'after' | 'before';   // returns are always deducted (no switch any more)
  const v0 = get('view', 'party') as View;
  const view = (v0 === 'item' ? 'party' : v0) as View;   // only Customer / Month / Transactions tabs (old Item-wise links open the first)
  const isSales = side === 'sales';
  const T = isSales ? { title: 'Sales', doc: 'Sales', ret: 'Credit notes', note: 'Credit note', party: 'Customer', color: HEX.sales }
                    : { title: 'Purchases', doc: 'Purchases', ret: 'Debit notes', note: 'Debit note', party: 'Creditor', color: HEX.purchases };
  const settings = { tax, returns };
  // Cards and chart come from one request that no tab changes, so switching tabs never touches them; the tab's own table
  // has its own request (the same one when it is the customer/supplier view without a search, so it is loaded once).
  const sum = useApi<any>(keys.spSummary(cid, side, period, { ...settings, groupBy: 'party', q: '' }));
  const groupKey = (v: View, q = '') => v === 'transactions' ? null : keys.spSummary(cid, side, period, { ...settings, groupBy: v, q });
  const txKey = (f: { party?: string; item?: string; q?: string; kind?: string; page?: string } = {}) =>
    keys.spTransactions(cid, side, period, { ...settings, ...f });
  // Customer / Supplier tab: one row per party — Date (its latest invoice in the period) · Party · Amount (its sales for the
  // period, after credit notes, Net or Gross as chosen) · Invoices (how many in the period). Month tab: totals per month.
  const grp = useApi<any>(view === 'transactions' ? null : groupKey(view, view === 'party' ? '' : ''));
  // Latest invoice date per party: from the server's row when it sends one, otherwise from the period's invoice list
  // (loaded in the background, all pages).
  const invKey = (f: { q?: string; page?: string } = {}) => txKey({ kind: 'documents', q: f.q, page: f.page });
  const needDates = view === 'party' && !!grp.data?.groups?.rows?.length && !grp.data.groups.rows.some((r: any) => r.lastDate || r.lastInvoiceDate);
  const inv = useInfiniteApi<any>(needDates ? (pg => invKey({ page: String(pg) })) : null);
  useEffect(() => { if (needDates && inv.data && !inv.done) inv.loadAll(); }, [needDates, inv.data, inv.done]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Transactions: one continuous sheet, the next rows load while scrolling (no pages).
  // A selected customer / supplier: the sheet is that party's whole account for the period — invoices, credit / debit
  // notes and payments — from its ledger (the party key is its ledger id), loaded continuously like any sheet.
  const partyMode = view === 'transactions' && !!get('party');
  const stmt = useInfiniteApi<any>(partyMode ? (pg => keys.ledger(cid, get('party'), period, String(pg))) : null, d => d.statement);
  const tx = useInfiniteApi<any>(view === 'transactions' && !partyMode ? (pg => txKey({ item: get('item'), q: '', kind: get('kind'), page: String(pg) })) : null);
  const s = sum.data;
  // Net = without tax, Gross = with tax: one toggle on the Total card drives the whole page (cards, chart, tables).
  const basis = tax === 'incl' ? 'Gross (incl. tax)' : 'Net (excl. tax)';
  const amountMenu = (
    <span className="card-menu" onPointerEnter={() => {   // load the other basis ahead, so switching is instant
      const v = tax === 'incl' ? 'excl' : 'incl';
      prefetchApi(keys.spSummary(cid, side, period, { tax: v, returns, groupBy: 'party', q: '' }));
      if (view !== 'transactions' && view !== 'party') prefetchApi(keys.spSummary(cid, side, period, { tax: v, returns, groupBy: view, q: '' }));
    }}>
      <Select ariaLabel="Amounts: net or gross" value={tax} onChange={v => set({ tax: v })}
        options={[{ value: 'excl', label: 'Net', hint: 'without tax' }, { value: 'incl', label: 'Gross', hint: 'with tax' }]} />
    </span>);
  const valueKey = returns === 'after' ? 'after' : 'before';

  const groupCols: Column<any>[] = [
    { key: 'label', label: view === 'month' ? 'Month' : view === 'item' ? 'Item' : T.party, primary: true, wrap: true, align: view === 'month' ? 'center' : 'left',
      render: r => view === 'item' ? <>{r.label}{r.other_units && <span className="tag neutral" style={{ marginLeft: 6 }}>Other units</span>}</> : r.label },
    ...(view === 'item' ? [{ key: 'qty', label: 'Quantity', num: true, render: (r: any) => r.qty == null ? '—' : `${formatQty(r.qty)} ${r.unit ?? ''}` } as Column<any>] : []),
    { key: 'before', label: `${T.doc} before returns`, num: true, render: r => money(r.before) },
    { key: 'returns', label: T.ret, num: true, render: r => money(r.returns) },
    { key: 'after', label: 'After returns', num: true, render: r => <b>{money(r.after)}</b> },
    { key: 'vouchers', label: 'Vouchers', num: true, hideSm: true },
  ];
  // Transactions sheet: Date · Customer/Supplier · Invoice no. · Total amount. The amount follows the Net / Gross choice
  // on the Total card (Net = taxable value, Gross = with tax), like every other figure on the page.
  const amountOf = (r: { taxable: string; total: string }) => tax === 'incl' ? r.total : r.taxable;
  // Party account: Date · Invoice no. · Invoice type · Amount. Sales: sale invoices green, credit notes / receipts red.
  // Purchases: purchase invoices red (money going out), debit notes / payments green.
  const raises = (r: any) => Number(isSales ? r.debit : r.credit) > 0;
  const amtClass = (r: any) => (raises(r) === isSales ? 'amt-up' : 'amt-down');
  const q = '';
  const stmtRows: any[] = q ? stmt.rows.filter(r => [r.voucherNumber, r.invoiceNumber, r.voucherType].some(x => String(x ?? '').toLowerCase().includes(q))) : stmt.rows;
  // The party's account opens with an Opening balance row (the balance on the period's first day).
  const openingRow = stmt.data?.statement ? [{ id: 'opening', opening: true, date: period.from, opening_balance: stmt.data.statement.opening }] : [];
  const acctRows: any[] = stmtRows.length ? [...openingRow, ...stmtRows] : stmtRows;
  const partyCols: Column<any>[] = [
    { key: 'date', label: 'Date', render: r => formatDate(r.date), sortValue: r => r.date },
    { key: 'invoiceNumber', label: 'Invoice no.', primary: true, span: r => r.opening ? 2 : 1, sortValue: r => r.invoiceNumber || r.voucherNumber,
      render: r => r.opening ? <b>Opening balance</b> : <>{r.invoiceNumber || r.voucherNumber || '—'}{r.cancelled && <span className="tag neutral" style={{ marginLeft: 6 }}>Cancelled</span>}</> },
    { key: 'voucherType', label: 'Invoice type', render: r => r.opening ? '' : r.voucherType ?? '—' },
    { key: 'amount', label: 'Amount', num: true, sortValue: r => Number(r.debit || r.credit || 0),
      render: r => r.opening ? <b>{money(String(r.opening_balance ?? ''))}</b> : <b className={amtClass(r)}>{money(Number(r.debit) ? r.debit : r.credit)}</b> },
  ];
  // An invoice row opens its party's whole account (Transactions for that party). Its key: the row's own partyId, else
  // looked up by name in the party list behind the cards.
  const partyKeyByName = new Map<string, string>((s?.groups?.rows ?? []).map((r: any) => [String(r.label), String(r.key)]));
  const partyKeyOf = (r: any): string | undefined => r.partyId ?? r.partyKey ?? partyKeyByName.get(String(r.party));
  const lastByParty = new Map<string, string>();
  for (const r of inv.rows) { const k = partyKeyOf(r); if (k && (!lastByParty.has(k) || r.date > lastByParty.get(k)!)) lastByParty.set(k, r.date); }
  const lastDateOf = (r: any): string | undefined => r.lastDate ?? r.lastInvoiceDate ?? lastByParty.get(String(r.key));
  const partyCols2: Column<any>[] = [
    { key: 'date', label: 'Date', title: 'Latest invoice in the period', sortValue: r => lastDateOf(r) ?? '',
      render: r => { const d = lastDateOf(r); return d ? formatDate(d) : needDates && !inv.done ? <SkText w={80} /> : '—'; } },
    { key: 'label', label: T.party, wrap: true, align: 'left', search: `Search ${T.party.toLowerCase()} name` },
    { key: 'vouchers', label: 'Invoices', num: true, sortValue: r => Number(r.vouchers ?? 0), render: r => r.vouchers ?? '—' },
    { key: 'after', label: 'Amount', num: true, sortValue: r => Number(r.after), render: r => <b>{money(r.after)}</b> },
  ];
  const txCols: Column<any>[] = [
    { key: 'date', label: 'Date', render: r => formatDate(r.date), sortValue: r => r.date },
    { key: 'party', label: T.party, wrap: true },
    { key: 'invoiceNumber', label: 'Invoice no.', primary: true, sortValue: r => r.invoiceNumber || r.voucherNumber,
      render: r => <>{r.invoiceNumber || r.voucherNumber}{r.isReturn && <span className="tag neutral" style={{ marginLeft: 6 }}>{T.note}</span>}{r.isUnbalanced && <span className="tag warn" style={{ marginLeft: 6 }}>! Check in Tally</span>}</> },
    { key: 'total', label: 'Total amount', num: true, sortValue: r => Number(amountOf(r)), render: r => <b>{money(amountOf(r))}</b> },
  ];
  const groups = grp.data?.groups;
  // Customer search (button in the Customer heading): kept here, so a search is still there after opening a customer and coming back.
  const partySearch = useColumnSearch(side);
  // Totals of the rows on screen: the period's totals, or the matching customers' totals while a search filters the list.
  const partyFooter = (shown: any[], filtered: boolean) => s ? (
    <tr className="total foot"><td colSpan={2} className="primary-cell">Total</td>
      <td className="num" data-label="Invoices">{shown.reduce((n: number, r: any) => n + Number(r.vouchers ?? 0), 0)}</td>
      <td className="num total-main" data-label="Amount">{money(filtered ? String(shown.reduce((n, r) => n + Math.round(Number(r.after) * 100), 0) / 100) : s.after)}</td></tr>) : null;
  const activeParty = get('party');
  const partyRow = activeParty ? s?.groups?.rows?.find((r: any) => String(r.key) === activeParty) : undefined;
  // The info box always shows the party's Gross amount after credit / debit notes (whatever Net / Gross the page uses), and
  // its maximum overdue days: the oldest overdue open invoice of the party on the balance date (same figures as Receivables / Payables).
  const grossSum = useApi<any>(partyMode && tax !== 'incl' ? keys.spSummary(cid, side, period, { tax: 'incl', returns, groupBy: 'party', q: '' }) : null);
  const grossRow = tax === 'incl' ? partyRow : grossSum.data?.groups?.rows?.find((r: any) => String(r.key) === activeParty);
  const asOf = balanceDate(period);
  const partyBills = useApi<any>(partyMode && activeParty ? `/v1/companies/${cid}/${isSales ? 'receivables' : 'payables'}/${activeParty}?${qs({ asOf })}` : null);
  const maxOverdue = partyBills.data ? Math.max(0, ...openInvoices(partyBills.data.bills, asOf).map(b => b.overdueDays)) : null;
  // The party's name: from the summary row, else from its ledger (a party with no invoices in the period).
  const partyName = partyRow?.label ?? (partyMode ? stmt.data?.ledger?.name : undefined);
  // Item name for the item filter: from the Item-wise list (already loaded when the row was clicked).
  const itemList = useApi<any>(view === 'transactions' && get('item') ? groupKey('item') : null);
  const itemName = get('item') && itemList.data?.groups?.rows?.find((r: any) => r.key === get('item'))?.label;

  return (
    <>
      <PageHead title={T.title} sub={<span className="print-only">{basis}</span>} period={{ value: period, onChange: setPeriod }}>
        <PrintButton />
      </PageHead>
      <ErrorNotice error={sum.error} onRetry={sum.reload} />
      {sum.loading && !s ? <Loading page cards={2} /> : s && (<>
        <div className="cards">
          <Card label={`Total ${T.title.toLowerCase()}`} value={rupees(s.total)} action={amountMenu} />
          <Card label={T.ret} value={rupees(s.returns)} onClick={() => set({ view: 'transactions', kind: 'returns' })} />
        </div>
        {s.counts.unbalanced > 0 && <Notice kind="warn">{s.counts.unbalanced} voucher(s) did not balance when read from Tally. They are labelled “Check in Tally”.</Notice>}
        <section className="panel" aria-labelledby="mchart">
          <div className="panel-head"><h2 id="mchart">{T.title} by month</h2></div>
          <div className="panel-body">
            <MonthlyBars title={`${T.title} by month`} data={s.monthly.map((m: any) => ({ month: m.month, value: m[valueKey] }))}
              series={[{ key: 'value', label: T.title, color: T.color }]} />
          </div>
        </section>
      </>)}
      {/* A customer's account: their info box sits above the sheet as its own card (name · invoices · maximum overdue days · gross
          amount for the period after credit notes); a click on it, or the browser's Back, returns to the customer list. */}
      {partyMode && (
        <InfoBox caption={`${T.title}: ${partyName ?? T.party}`} expanded onClick={() => set({ view: null, party: null }, true)} cells={[
          { label: T.party, value: partyName ?? (s && stmt.data ? '—' : <SkText w={160} />) },
          { label: 'Invoices', value: partyRow ? partyRow.vouchers ?? '—' : s ? '—' : <SkText w={40} /> },
          { label: 'Max due', value: maxOverdue !== null ? (maxOverdue > 0 ? maxOverdue : '—') : partyBills.error ? '—' : <SkText w={40} /> },
          { label: 'Amount', value: grossRow ? money(grossRow.after) : s && (tax === 'incl' || grossSum.data) ? '—' : <SkText w={80} />, strong: true },
        ]} />)}
      <section className="panel">
        {/* No tabs: the sheet opens on the customer / creditor list (search button in its name heading). A card or a chart
            month opens the matching transactions, titled by a blue bar; the browser's Back returns to the list. */}
        {view !== 'party' && !partyMode && (
          <div className="sheet-title">{get('item') ? itemName : get('kind') === 'returns' ? T.ret : get('kind') === 'documents' ? `${T.doc} invoices` : view === 'month' ? 'By month' : `All ${T.doc.toLowerCase()}`}</div>)}
        <TabPanel>
        {partyMode ? (
          <>
            <ErrorNotice error={stmt.error} onRetry={stmt.reload} />
            {stmt.loading && !stmt.data ? <Loading /> : stmt.data && <>
              <DataTable<any> caption={`${partyName ?? T.party} — transactions`} columns={partyCols} rows={acctRows} rowKey={r => r.id}
                rowHref={r => r.opening ? undefined : cpath(cid, `vouchers/${r.id}`)} rowClass={r => r.opening ? 'opening-row' : r.cancelled ? 'muted-row' : undefined}
                empty="No transactions for this party in this period."
                footer={stmt.done && !q && <tr className="total foot"><td colSpan={3} className="primary-cell">Closing balance</td><td className="num total-main" data-label="Closing balance"><Balance v={stmt.data.statement.closing} /></td></tr>} />
              <LoadMore list={stmt} />
            </>}
          </>
        ) : view === 'transactions' ? (
          <>
            <ErrorNotice error={tx.error} onRetry={tx.reload} />
            {tx.loading && !tx.data ? <Loading /> : tx.data && <>
              <DataTable<any> caption={`${T.title} transactions`} columns={txCols} rows={tx.rows} rowKey={r => r.id}
                rowHref={r => cpath(cid, `vouchers/${r.id}`)}
                footer={tx.done && <tr className="total foot"><td colSpan={3} className="primary-cell">Total of {tx.total} vouchers</td><td className="num total-main" data-label="Total amount">{money(amountOf(tx.data.totals))}</td></tr>} />
              <LoadMore list={tx} />
            </>}
          </>
        ) : view === 'party' ? (
          <>
            <ErrorNotice error={grp.error} onRetry={grp.reload} />
            {grp.loading && !groups ? <Loading /> : groups && (
              <DataTable<any> caption={`${T.title} by ${T.party.toLowerCase()}`} columns={partyCols2} rows={groups.rows} rowKey={r => String(r.key)}
                onRowClick={r => set({ view: 'transactions', party: String(r.key), q: null }, true)}
                initialSort={{ key: 'after', dir: 'desc' }} empty={`No ${T.doc.toLowerCase()} in this period.`}
                search={partySearch} footer={partyFooter} />)}
          </>
        ) : <>
            <ErrorNotice error={grp.error} onRetry={grp.reload} />
            {grp.loading && !groups ? <Loading /> : groups && <>
            <DataTable<any> caption={`${T.title} grouped`} columns={groupCols} rows={groups.rows} rowKey={r => String(r.key)}
              onRowClick={r => view === 'month' ? set({ ...monthRange(r.key), view: 'transactions' }, true) : set({ view: 'transactions', [view === 'item' ? 'item' : 'party']: r.key, q: null }, true)}
              initialSort={{ key: view === 'month' ? 'label' : 'after', dir: view === 'month' ? 'asc' : 'desc' }}
              footer={groups.rows.length > 0 && view !== 'item' && s ? <tr className="total foot"><td className="primary-cell">Total</td><td className="num" data-label="Before">{money(s.before)}</td><td className="num" data-label="Returns">{money(s.returns)}</td><td className="num total-main" data-label="After">{money(s.after)}</td><td className="hide-sm" /></tr> : undefined} />
          </>}
        </>}
        </TabPanel>
      </section>
    </>
  );
}
