'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { freshness, syncedText } from '@/lib/period';
import { PageHead, useCompany } from '@/components/shell';
import { DataTable, ErrorNotice, Loading, Notice } from '@/components/ui';
import { ConnectTally } from '@/components/connect';
import { keys } from '@/lib/keys';

const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function SyncStatus() {
  const { company, me, reloadMe } = useCompany();
  const cid = company.id;
  const { data, error, loading, reload } = useApi<any>(keys.syncStatus(cid), 10_000);
  const devices = useApi<any>(keys.devices(), 10_000);
  const [msg, setMsg] = useState<string | null>(null);
  const fr = freshness(company);
  const owner = me.user.role === 'owner';

  const activePcs = (devices.data?.devices ?? []).filter((d: any) => !d.revokedAt).length;
  async function revoke(id: string, name: string) {
    if (!confirm(`Remove “${name}”? It will stop syncing until paired again. Synced data is kept.`)) return;
    try { await api(`/v1/devices/${id}/revoke`, { method: 'POST' }); devices.reload(); } catch (e: any) { setMsg(e.message); }
  }
  const c = data?.company;
  const tallyStatus = c?.deviceStatus?.tally;

  return (
    <>
      <PageHead title="Sync Status" sub="Connection between Tally on your PC and these reports">
        <button className="btn" onClick={() => { reload(); devices.reload(); reloadMe(); }}>Refresh</button>
      </PageHead>
      <ErrorNotice error={error} onRetry={reload} />
      {msg && <Notice kind="err">{msg}</Notice>}
      {loading && !data ? <Loading page /> : data && (<>
        <div className="cards">
          <div className="card"><div className="k">Reports data</div><div className="v" style={{ fontSize: 16 }}><span className={`tag ${fr.state === 'fresh' ? 'ok' : fr.state === 'failed' ? 'err' : 'warn'}`}>{fr.state === 'fresh' ? '✓' : '!'} {fr.label}</span></div>
            <div className="d">Last published {dt(c.lastPublishedAt)}</div></div>
          <div className="card"><div className="k">Connector</div><div className="v" style={{ fontSize: 16 }}>{c.device ?? 'Not paired'}</div>
            <div className="d">Last seen {dt(c.deviceLastSeenAt)}{c.connectorVersion ? ` · v${c.connectorVersion}` : ''}</div></div>
          <div className="card"><div className="k">Tally (as reported by the PC)</div><div className="v" style={{ fontSize: 16 }}>{tallyStatus ? (tallyStatus.ok ? '✓ Reachable' : '✕ Not reachable') : '—'}</div>
            <div className="d">{tallyStatus?.message ?? 'No report yet'}</div></div>
          <div className="card"><div className="k">Synced records</div><div className="v" style={{ fontSize: 16 }}>{data.counts.vouchers.toLocaleString('en-IN')} vouchers</div>
            <div className="d">{data.counts.ledgers} ledgers · {data.counts.items} items · {data.counts.firstDate ?? '—'} to {data.counts.lastDate ?? '—'}</div></div>
        </div>
        {c.lastError && <Notice kind="warn">Most recent problem: {c.lastError}. The reports keep showing the last complete data ({syncedText(c.lastPublishedAt)}).</Notice>}
        {c.deviceStatus?.pendingRecords > 0 && <Notice kind="info">{c.deviceStatus.pendingRecords.toLocaleString('en-IN')} record(s) are waiting on the PC to upload. They will be sent automatically.</Notice>}

        <section className="panel">
          <div className="panel-head"><h2>Data notes</h2><span className="small muted">Limitations found in the Tally data</span></div>
          <div className="panel-body">
            {data.notes.length === 0 ? <span className="muted">No issues found.</span> : <ul style={{ margin: 0, paddingLeft: 18 }}>{data.notes.map((n: any) => <li key={n.code} style={{ marginBottom: 4 }}><span className={`tag ${n.severity === 'warning' ? 'warn' : 'neutral'}`}>{n.severity === 'warning' ? '! Check' : 'i Note'}</span> {n.message}</li>)}</ul>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Recent syncs</h2></div>
          <DataTable<any> caption="Recent sync runs" rows={data.runs} rowKey={r => r.id} columns={[
            { key: 'startedAt', label: 'Started', render: r => dt(r.startedAt), sortValue: r => r.startedAt },
            { key: 'kind', label: 'Type', render: r => ({ full: 'Full', incremental: 'Changes only', reconcile: 'Reconcile' } as any)[r.kind] ?? r.kind },
            { key: 'status', label: 'Result', render: r => <span className={`tag ${r.status === 'committed' ? 'ok' : r.status === 'failed' ? 'err' : 'neutral'}`}>{r.status === 'committed' ? '✓ Published' : r.status === 'failed' ? '✕ Failed' : r.status === 'open' ? '… In progress' : 'Expired'}</span> },
            { key: 'stats', label: 'Changes', wrap: true, sortable: false, render: r => r.error ? <span className="muted">{r.error}</span> : r.stats ? summarize(r.stats) : '—' },
          ]} empty="No syncs yet." />
        </section>
      </>)}

      <section className="panel">
        <div className="panel-head"><h2>Connected PCs</h2></div>
        <div className="panel-body">
          {owner && <div style={{ marginBottom: 14 }}><ConnectTally label={activePcs ? 'Connect another PC' : 'Connect Tally'} onConnected={() => { devices.reload(); reload(); reloadMe(); }} /></div>}
          {devices.loading && !devices.data ? <Loading /> : devices.data && (
            <DataTable<any> caption="Devices" rows={devices.data.devices} rowKey={r => r.id} columns={[
              { key: 'name', label: 'Device', primary: true },
              { key: 'lastSeenAt', label: 'Last seen', render: r => dt(r.lastSeenAt) },
              { key: 'connectorVersion', label: 'Version', hideSm: true, render: r => r.connectorVersion ?? '—' },
              { key: 'state', label: 'Status', sortable: false, render: r => r.revokedAt ? <span className="tag neutral">Removed</span> : <span className="tag ok">✓ Active</span> },
              { key: 'actions', label: '', sortable: false, render: r => owner && !r.revokedAt ? <button className="btn sm" onClick={() => revoke(r.id, r.name)}>Remove</button> : null },
            ]} empty="No connector has been paired yet." />)}
        </div>
      </section>
    </>
  );
}

function summarize(stats: any) {
  const a = stats.applied ?? {}, d = stats.deleted ?? {}, h = stats.held ?? {};
  const parts: string[] = [];
  if (a.voucher) parts.push(`${a.voucher} vouchers`);
  const m = ['ledger', 'group', 'stockItem'].reduce((s, k) => s + (a[k] ?? 0), 0);
  if (m) parts.push(`${m} masters`);
  if (a.stockValuation) parts.push('stock valuation');
  const del = Object.values(d).reduce((s: number, n: any) => s + n, 0);
  if (del) parts.push(`${del} removed`);
  const held = Object.values(h).reduce((s: number, n: any) => s + n, 0);
  if (held) parts.push(`${held} removals held for confirmation`);
  return parts.join(' · ') || 'No changes';
}
