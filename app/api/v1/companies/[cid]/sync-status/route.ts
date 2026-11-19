import { requireCompany, requireUser } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, ctx: { params: Promise<{ cid: string }> }) => {
  const s = await requireUser(req);
  const { cid } = await ctx.params;
  const c = await requireCompany(s, cid);

  const [[dev], [n], [led], [itm], runs] = await Promise.all([
    c.device_id ? sql`select name, last_seen_at, connector_version, status, revoked_at from devices where id = ${c.device_id}` : Promise.resolve([] as any[]),
    sql`select count(*) filter (where not deleted)::int as vouchers,
               count(*) filter (where not deleted and unbalanced)::int as unbalanced,
               count(*) filter (where not deleted and cancelled)::int as cancelled,
               count(*) filter (where not deleted and optional)::int as optional
          from vouchers where company_id = ${cid}`,
    sql`select count(*)::int as n from ledgers where company_id = ${cid}`,
    sql`select count(*)::int as n from stock_items where company_id = ${cid}`,
    sql`select id, started_at, kind, status, error, stats from sync_runs where company_id = ${cid} order by started_at desc limit 15`,
  ]);
  const [bills] = await sql`select count(*)::int as n from bills where company_id = ${cid}`;

  const notes: { code: string; severity: 'warning' | 'info'; message: string }[] = [];
  if (!dev) notes.push({ code: 'no-device', severity: 'warning', message: 'No PC is connected to this company yet. Use “Connect Tally” below.' });
  else if (dev.revoked_at) notes.push({ code: 'device-removed', severity: 'warning', message: 'The PC that synced this company was removed. Connect it again to resume syncing.' });
  if (n.unbalanced > 0) notes.push({ code: 'unbalanced', severity: 'warning', message: `${n.unbalanced} voucher(s) do not balance in Tally. They are flagged in the transaction lists.` });
  if (n.cancelled > 0) notes.push({ code: 'cancelled', severity: 'info', message: `${n.cancelled} cancelled voucher(s) are left out of all totals.` });
  if (n.optional > 0) notes.push({ code: 'optional', severity: 'info', message: `${n.optional} optional voucher(s) are left out of all totals.` });
  if (n.vouchers > 0 && bills.n === 0) notes.push({ code: 'no-bills', severity: 'info', message: 'Tally reported no pending bills, so Receivables and Payables are built from ledger balances only.' });

  return json({
    company: {
      lastPublishedAt: c.last_published_at, device: dev?.name ?? null, deviceLastSeenAt: dev?.last_seen_at ?? null,
      connectorVersion: dev?.connector_version ?? null, lastError: c.last_error,
      deviceStatus: dev?.status && Object.keys(dev.status).length ? dev.status : null,
    },
    counts: { vouchers: n.vouchers, ledgers: led.n, items: itm.n, firstDate: c.first_voucher_date, lastDate: c.last_voucher_date },
    notes,
    runs: runs.map(r => ({ id: r.id, startedAt: r.started_at, kind: r.kind, status: r.status, error: r.error, stats: r.stats })),
  });
});
