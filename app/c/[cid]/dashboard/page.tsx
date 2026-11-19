'use client';
import { useApi } from '@/lib/api';
import { periodText, balanceDate } from '@/lib/period';
import { PageHead, usePeriod, useCompany, qs, cpath } from '@/components/shell';
import { Card, ErrorNotice, Loading, rupees, formatDate } from '@/components/ui';
import { MonthlyBars, HEX } from '@/components/charts';
import { keys } from '@/lib/keys';

export default function Dashboard() {
  const { company } = useCompany();
  const [period, setPeriod] = usePeriod();
  const { data, error, loading, reload } = useApi<any>(keys.dashboard(company.id, period));
  const cid = company.id;
  const P = { from: period.from, to: period.to };
  const c = data?.cards;

  return (
    <>
      <PageHead title="Dashboard" period={{ value: period, onChange: setPeriod }} />
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? <Loading page /> : c && (
        <>
          <h2 className="sr-only">For the period</h2>
          <div className="cards">
            <Card label="Sales" value={rupees(c.sales.amount)} detail={`Incl. tax, after returns · ${periodText(period)}`} href={cpath(cid, 'sales', P)} />
            <Card label="Purchases" value={rupees(c.purchases.amount)} detail={`Incl. tax, after returns · ${periodText(period)}`} href={cpath(cid, 'purchases', P)} />
            <Card label="Receipts" value={rupees(c.receipts.amount)} detail={periodText(period)} href={cpath(cid, 'receipts', P)} />
            <Card label="Payments" value={rupees(c.payments.amount)} detail={periodText(period)} href={cpath(cid, 'payments', P)} />
            <Card label="Receivables" hint="Balance" value={rupees(c.receivables.amount)} detail={`Net, as of ${formatDate(c.receivables.asOf)} · pending bills ${rupees(c.receivables.pending)}`} href={cpath(cid, 'receivables', { ...P, asOf: c.receivables.asOf })} />
            <Card label="Payables" hint="Balance" value={rupees(c.payables.amount)} detail={`Net, as of ${formatDate(c.payables.asOf)} · pending bills ${rupees(c.payables.pending)}`} href={cpath(cid, 'payables', { ...P, asOf: c.payables.asOf })} />
            <Card label="Closing stock" hint="Balance" value={c.stock.amount != null ? rupees(c.stock.amount) : '—'}
                  detail={c.stock.asOf ? `Tally valuation as of ${formatDate(c.stock.asOf)}` : 'No valuation synced for this period'} href={cpath(cid, 'stock', P)} />
            <div className="card">
              <div className="k"><span>Quick access</span></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <a className="btn sm" href={cpath(cid, 'stock', P)}>Items · {data.quick.items}</a>
              </div>
            </div>
          </div>
          <div className="grid-2">
            <section className="panel" aria-labelledby="t1">
              <div className="panel-head"><h2 id="t1">Sales and purchases by month</h2><span className="small muted">Incl. tax, after returns</span></div>
              <div className="panel-body">
                <MonthlyBars title="Sales and purchases by month" data={data.trends}
                  series={[{ key: 'sales', label: 'Sales', color: HEX.sales }, { key: 'purchases', label: 'Purchases', color: HEX.purchases }]} />
              </div>
            </section>
            <section className="panel" aria-labelledby="t2">
              <div className="panel-head"><h2 id="t2">Receipts and payments by month</h2></div>
              <div className="panel-body">
                <MonthlyBars title="Receipts and payments by month" data={data.trends}
                  series={[{ key: 'receipts', label: 'Receipts', color: HEX.receipts }, { key: 'payments', label: 'Payments', color: HEX.payments }]} />
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
