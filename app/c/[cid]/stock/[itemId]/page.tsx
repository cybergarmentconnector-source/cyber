'use client';
import { use } from 'react';
import { useInfiniteApi } from '@/lib/api';
import { keys } from '@/lib/keys';
import { periodText } from '@/lib/period';
import { PageHead, PrintButton, usePeriod, useCompany, cpath } from '@/components/shell';
import { Card, DataTable, ErrorNotice, LoadMore, Loading, SkText, money, formatQty, formatDate, Column } from '@/components/ui';

export default function StockItem({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = use(params);
  const { company } = useCompany();
  const cid = company.id;
  const [period, setPeriod] = usePeriod();
  // Movements: one continuous sheet, the next ones load while scrolling (no pages).
  const list = useInfiniteApi<any>(pg => keys.stockItem(cid, itemId, period, String(pg)), d => ({ rows: d.movements, total: d.total, pageSize: d.pageSize }));
  const { data, error, loading, reload } = list;
  const it = data?.item, s = data?.summary;
  const cols: Column<any>[] = [
    { key: 'date', label: 'Date', render: r => formatDate(r.date), sortable: false },
    { key: 'voucherType', label: 'Voucher', primary: true, sortable: false, render: r => <>{r.voucherType} {r.voucherNumber}</> },
    { key: 'party', label: 'Party', wrap: true, sortable: false, render: r => r.party ?? '—' },
    { key: 'in', label: 'Inward', num: true, sortable: false, render: r => r.direction === 'in' ? `${formatQty(r.qty)}${r.baseUnit ? '' : ` ${r.unit}`}` : '' },
    { key: 'out', label: 'Outward', num: true, sortable: false, render: r => r.direction === 'out' ? `${formatQty(r.qty)}${r.baseUnit ? '' : ` ${r.unit}`}` : '' },
    { key: 'rate', label: 'Rate', num: true, sortable: false, hideSm: true, render: r => money(r.rate) },
    { key: 'amount', label: 'Value', num: true, sortable: false, hideSm: true, render: r => money(r.amount) },
    { key: 'runningQty', label: 'Balance qty', num: true, sortable: false, render: r => <b>{formatQty(r.runningQty)}</b> },
  ];
  return (
    <>
      <PageHead title={it?.name ?? (error ? 'Item' : <SkText w={220} big />)} sub={it ? [it.alias, it.group, it.category, it.unit && `Unit: ${it.unit}`].filter(Boolean).join(' · ') : error ? '' : <SkText w={260} />}
        crumbs={[{ href: cpath(cid, 'stock', period as any), label: 'Stock' }, { label: it?.name ?? (error ? '' : <SkText w={90} />) }]}
        period={{ value: period, onChange: setPeriod }}>
        <PrintButton />
      </PageHead>
      <ErrorNotice error={error} onRetry={reload} />
      {loading && !data ? <Loading page /> : data && (<>
        <div className="cards">
          <Card label="Opening" value={`${formatQty(s?.opening)} ${it.unit ?? ''}`} detail={formatDate(period.from)} />
          <Card label="Inward" value={formatQty(s?.inward)} /><Card label="Outward" value={formatQty(s?.outward)} />
          <Card label="Closing" value={`${formatQty(s?.closing)} ${it.unit ?? ''}`} detail={Number(s?.closing) < 0 ? '! Negative stock' : formatDate(period.to)} />
          <Card label="Closing value" value={money(s?.valueAtValuationDate)} detail="Tally valuation" />
          <Card label="Avg purchase rate" value={money(s?.avgPurchaseRate)} detail={`Standard price ${money(it.standardPrice)}`} />
        </div>
        <div className="grid-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <section className="panel">
            <div className="panel-head"><h2>Movements</h2><span className="small muted">{periodText(period)}</span></div>
            <DataTable<any> caption="Item movements" columns={cols} rows={list.rows} rowKey={(r, i) => `${r.voucherId}:${i}`} rowHref={r => cpath(cid, `vouchers/${r.voucherId}`)} empty="No movements in this period." />
            <LoadMore list={list} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2>By godown</h2><span className="small muted">as of {formatDate(period.to)}</span></div>
            <DataTable<any> caption="Godown quantities" columns={[{ key: 'godown', label: 'Godown', primary: true }, { key: 'qty', label: 'Quantity', num: true, render: (r: any) => formatQty(r.qty) }]} rows={data.godowns} rowKey={r => r.godown} empty="Godowns are not maintained for this item." />
          </section>
        </div>
      </>)}
    </>
  );
}
