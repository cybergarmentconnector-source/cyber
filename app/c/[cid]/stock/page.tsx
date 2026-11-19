'use client';
import { useEffect, useState } from 'react';
import { useApi, fetchCached } from '@/lib/api';
import { monthRange, todayIso } from '@/lib/period';
import { PageHead, PrintButton, usePeriod, useCompany } from '@/components/shell';
import { Card, ErrorNotice, Loading, rupees, formatDate } from '@/components/ui';
import { MonthlyBars } from '@/components/charts';
import { keys } from '@/lib/keys';

export default function Stock() {
  const { company } = useCompany();
  const cid = company.id;
  const [period, setPeriod] = usePeriod();
  const { data, error, loading, reload } = useApi<any>(keys.stock(cid, period, { view: 'item' }));
  // Month-end stock value. A server-provided `monthly` series is used when present; otherwise each month's closing
  // quantities are loaded (FY start → month end) and valued at each item's average purchase rate (standard price if none).
  // The month holding the Tally valuation date uses Tally's own closing value, so it matches the card above.
  const [calc, setCalc] = useState<Record<string, string>[] | null>(null);
  const serverMonthly: Record<string, string>[] = (data?.monthly ?? []).map((m: any) => ({ month: m.month, value: String(m.value ?? m.amount ?? '0') }));
  const haveData = !!data, valDate: string | null = data?.valuationDate ?? null, total = data?.totalValue;
  useEffect(() => {
    if (!haveData || serverMonthly.length) { setCalc(null); return; }
    let live = true;
    const upTo = [period.to, valDate ?? todayIso(), todayIso()].sort()[0];
    const months: string[] = [];
    for (let d = new Date(period.from + 'T00:00:00'); `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` <= upTo.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    Promise.all(months.map(async ym => {
      if (valDate && ym === valDate.slice(0, 7) && total != null) return { month: ym, value: String(total) };
      const to = [monthRange(ym).to, upTo].sort()[0];
      const d = await fetchCached<any>(keys.stock(cid, { from: period.from, to }, { view: 'item' }));
      const v = (d.rows ?? []).reduce((sum: number, r: any) => sum + Math.max(0, Number(r.closing) || 0) * (Number(r.avgPurchaseRate) || Number(r.standardPrice) || 0), 0);
      return { month: ym, value: v.toFixed(2) };
    })).then(r => { if (live) setCalc(r); }).catch(() => { if (live) setCalc([]); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, period.from, period.to, haveData, valDate, total, serverMonthly.length]);
  const monthly = serverMonthly.length ? serverMonthly : calc ?? [];

  return (
    <>
      <PageHead title="Stock" period={{ value: period, onChange: setPeriod }}>
        <PrintButton />
      </PageHead>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? <Loading page /> : data && (<>
        <div className="cards">
          <Card label="Closing stock value" value={rupees(data.totalValue)} detail={data.valuationDate ? `Tally valuation as of ${formatDate(data.valuationDate)}` : 'No valuation captured yet'} />
          {data.counts && <Card label="Negative stock" value={String(data.counts.negative)} detail="Closing quantity below zero" />}
        </div>
        <section className="panel" aria-labelledby="stockchart">
          <div className="panel-head"><h2 id="stockchart">Closing stock value by month</h2><span className="small muted">Value of stock at each month end</span></div>
          <div className="panel-body">
            {calc === null && !serverMonthly.length ? <Loading /> : monthly.length
              ? <MonthlyBars title="Closing stock value by month" data={monthly} series={[{ key: 'value', label: 'Closing stock value', color: '#7a5af8' }]} />
              : <p className="muted small" style={{ margin: 0 }}>Month-wise stock values could not be loaded.</p>}
          </div>
        </section>
      </>)}
    </>
  );
}
