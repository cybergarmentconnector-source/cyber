'use client';
import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/lib/api';
import { PageHead, PrintButton, RouteSkeleton, useCompany, cpath } from '@/components/shell';
import { keys } from '@/lib/keys';
import { DataTable, ErrorNotice, Notice, StatusTag, money as money0, formatDate, formatQty, rupees as rupees0, INVOICE_DECIMALS } from '@/components/ui';

// This page is the invoice: amounts keep their paise here (everywhere else the site shows whole rupees).
const money = (v: string | null | undefined) => money0(v, INVOICE_DECIMALS);
const rupees = (v: string | null | undefined) => rupees0(v, INVOICE_DECIMALS);
import { Icon } from '@/components/icons';

export default function VoucherDetail({ params }: { params: Promise<{ vid: string }> }) {
  const { vid } = use(params);
  const { company } = useCompany();
  const cid = company.id;
  const router = useRouter();
  const { data, error, loading, reload } = useApi<any>(keys.voucher(cid, vid));
  if (loading && !data) return <RouteSkeleton />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  // The page shows the voucher's details, items, totals and narration (no Settlement / Accounting entries sections).
  const { voucher: v, items, invoice, createdBills, settlement } = data;
  const due = createdBills?.[0]?.dueDate;
  const pdf = `/api/v1/companies/${cid}/vouchers/${vid}/pdf`;
  const back = () => (history.length > 1 ? router.back() : router.push(cpath(cid, 'dashboard')));

  return (
    <>
      <div className="no-print" style={{ marginBottom: 8 }}><button className="btn ghost sm" onClick={back}><Icon.back />Back</button></div>
      <PageHead title={`${v.voucherType} ${v.voucherNumber ?? ''}`} sub={<>{formatDate(v.date)}{v.party && <> · {v.party}</>}</>}>
        <div className="toolbar no-print">
          <a className="btn" href={pdf} target="_blank" rel="noopener"><Icon.pdf />PDF</a>
          <PrintButton />
        </div>
      </PageHead>
      {v.cancelled && <Notice kind="warn">This voucher is cancelled in Tally. It is not included in any totals.</Notice>}
      {v.optional && <Notice kind="info">This is an optional voucher in Tally. It does not affect the books or these reports.</Notice>}
      {v.deleted && <Notice kind="warn">This voucher no longer exists in Tally (removed after a complete sync).</Notice>}
      {v.unbalanced && <Notice kind="warn">The debit and credit totals of this voucher did not match when read from Tally. Please check it in Tally.</Notice>}

      <section className="panel">
        <div className="panel-body">
          <div className="detail-head">
            <div className="kv">
              <div><span>Voucher type</span><b>{v.voucherType}{v.baseType && v.baseType !== v.voucherType ? ` (${v.baseType})` : ''}</b></div>
              <div><span>Voucher no.</span><b>{v.voucherNumber ?? '—'}</b></div>
              {v.invoiceNumber && v.invoiceNumber !== v.voucherNumber && <div><span>Reference / invoice no.</span><b>{v.invoiceNumber}</b></div>}
              <div><span>Date</span><b>{formatDate(v.date)}</b></div>
              {invoice && <div><span>Due date</span><b>{due ? formatDate(due) : 'Not set in Tally'}</b></div>}
              {v.party && <div><span>Party</span><b>{v.party}</b></div>}
              {v.partyGstin && <div><span>Party GSTIN</span><b>{v.partyGstin}</b></div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              {invoice && <><div className="small muted">Invoice total</div><div className="big-amount">{rupees(invoice.total)}</div></>}
              {settlement && <div style={{ marginTop: 6 }}><StatusTag status={settlement.status} title={settlement.reason} />{settlement.outstanding !== undefined && Number(settlement.outstanding) > 0 && <div className="small muted" style={{ marginTop: 4 }}>Outstanding now {rupees(settlement.outstanding)}</div>}</div>}
            </div>
          </div>
        </div>
      </section>

      {items.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Items</h2></div>
          <DataTable<any> caption="Items" rows={items} rowKey={r => String(r.line)} columns={[
            { key: 'line', label: '#', sortable: false, width: 56 },
            { key: 'item', label: 'Item', primary: true, wrap: true, sortable: false, render: r => <>{r.itemId ? <a href={cpath(cid, `stock/${r.itemId}`)}>{r.item}</a> : r.item}{r.godowns?.[0]?.godown && <div className="muted small">{r.godowns.map((g: any) => `${g.godown}${g.batch ? ` / ${g.batch}` : ''}`).join(', ')}</div>}</> },
            { key: 'qty', label: 'Quantity', num: true, sortable: false, render: r => formatQty(r.billedQty ?? r.qty) },
            { key: 'unit', label: 'Unit', sortable: false, render: r => r.unit ?? '—' },
            { key: 'rate', label: 'Rate', num: true, sortable: false, render: r => money(r.rate) },
            { key: 'discount', label: 'Disc %', num: true, sortable: false, render: r => r.discount && Number(r.discount) !== 0 ? formatQty(r.discount) : '—' },
            { key: 'amount', label: 'Amount', num: true, sortable: false, render: r => money(r.amount) },
          ]} />
        </section>
      )}

      {invoice && (
        <section className="panel">
          <div className="panel-body">
            <div className="totals">
              {invoice.itemsSubtotal != null && <div><span>Items subtotal</span><span>{money(invoice.itemsSubtotal)}</span></div>}
              {invoice.revenueLedgers.length > 1 && invoice.revenueLedgers.map((r: any, i: number) => <div key={`r${i}`}><span className="muted">{r.ledger}</span><span>{money(r.amount)}</span></div>)}
              <div><span>Taxable value</span><span>{money(invoice.taxable)}</span></div>
              {invoice.taxes.map((t: any, i: number) => <div key={`t${i}`}><span>{t.ledger}</span><span>{money(t.amount)}</span></div>)}
              {invoice.charges.map((c: any, i: number) => <div key={`c${i}`}><span>{c.ledger}</span><span>{money(c.amount)}</span></div>)}
              <div className="grand"><span>Total</span><span>{rupees(invoice.total)}</span></div>
            </div>
          </div>
        </section>
      )}

      {v.narration && <section className="panel"><div className="panel-head"><h2>Narration</h2></div><div className="panel-body">{v.narration}</div></section>}
    </>
  );
}
