'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Icon } from './icons';

export interface Series { key: string; label: string; color: string }

const BarCanvas = dynamic(() => import('./chart-canvas'), { ssr: false, loading: () => <div className="sk sk-chart" aria-hidden="true" /> });

/**
 * Monthly bar chart. Values arrive as decimal strings; they become numbers only to draw bars.
 * View only: hover shows exact amounts.  A button switches between bar and line.
 */
export function MonthlyBars({ data, series, height = 230, title }: {
  data: Record<string, string>[]; series: Series[]; height?: number; title: string;
}) {
  const [kind, setKind] = useState<'bar' | 'line'>('bar');
  const rows = data.map(d => ({ month: d.month, ...Object.fromEntries(series.map(s => [s.key, Number(d[s.key] ?? 0)])), raw: d }));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        {series.length > 1 ? <div className="chart-legend" aria-hidden="true">{series.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div> : <span />}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm no-print" onClick={() => setKind(k => k === 'bar' ? 'line' : 'bar')} aria-label={kind === 'bar' ? `Show ${title} as a line chart` : `Show ${title} as a bar chart`}>
          {kind === 'bar' ? <><Icon.line />Line</> : <><Icon.chart />Bar</>}
        </button>
      </div>
      <div style={{ height }} role="img" aria-label={`${title}: monthly ${kind} chart.`}>
        <BarCanvas rows={rows} series={series} kind={kind} />
      </div>
    </div>
  );
}

export const COLORS = { sales: 'var(--series-1)', purchases: 'var(--series-2)', receipts: 'var(--series-3)', payments: 'var(--series-4)', returns: '#9aa4b2' };
export const HEX = { sales: '#2a78d6', purchases: '#eb6834', receipts: '#1baf7a', payments: '#eda100' };
