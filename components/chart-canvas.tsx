'use client';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatIndian } from '@/lib/money';
import { monthLabel } from '@/lib/period';
import type { Series } from './charts';

/** Chart line colours in one place: faint horizontal grid, and a slightly stronger 1px baseline at zero. */
const LINE = { grid: '#edf0f3', base: '#cdd3da' };

/** The recharts part of MonthlyBars. Loaded on demand so pages show their cards and tables before the chart library arrives. */
export default function BarCanvas({ rows: allRows, series, kind = 'bar' }: { rows: any[]; series: Series[]; kind?: 'bar' | 'line' }) {
  // Months after the last one with any figure are empty, so the chart ends there instead of reserving blank space.
  let last = allRows.length - 1;
  while (last > 0 && series.every(s => !(Number(allRows[last][s.key]) || 0))) last--;
  const rows = allRows.slice(0, last + 1);
  const Chart: any = kind === 'line' ? LineChart : BarChart;
  const common = kind === 'line' ? {} : { barGap: 2, barCategoryGap: '22%' };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <Chart data={rows} {...common} margin={{ top: 6, right: kind === 'line' ? 12 : 4, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} stroke={LINE.grid} />
        <XAxis dataKey="month" tickFormatter={monthLabel} tickLine={false} axisLine={{ stroke: '#d6dbe1' }} hide tick={{ fontSize: 11, fill: '#6b7686' }} interval="preserveStartEnd" minTickGap={8} padding={kind === 'line' ? { left: 12, right: 12 } : undefined} />
        <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b7686' }} width={0} hide />
        {/* Baseline at zero, drawn by the chart itself so it never depends on the (hidden) axes. */}
        <ReferenceLine y={0} stroke={LINE.base} strokeWidth={1} ifOverflow="visible" style={{ shapeRendering: 'crispEdges' }} />
        <Tooltip cursor={kind === 'line' ? { stroke: '#d6dbe1' } : { fill: 'rgba(29,95,191,0.06)' }} content={({ active, payload, label }: any) => active && payload?.length ? (
          <div className="chart-tooltip">
            <div className="t">{monthLabel(label)}</div>
            {series.map(s => <div className="r" key={s.key}><span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}</span><b>₹ {formatIndian(payload[0].payload.raw[s.key] ?? '0')}</b></div>)}
          </div>) : null} />
        {kind === 'line'
          ? series.map(s => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2.5} dot={{ r: 3, fill: s.color, strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />)
          : series.map(s => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />)}
      </Chart>
    </ResponsiveContainer>
  );
}
