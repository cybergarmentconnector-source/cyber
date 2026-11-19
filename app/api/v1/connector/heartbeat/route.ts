import { requireDevice } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { body, json, route, str } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req: Request) => {
  const dev = await requireDevice(req);
  const b = await body(req);
  const status = {
    tally: { ok: !!b.tally?.ok, message: str(b.tally?.message, 300) ?? '' },
    pendingRecords: Math.max(0, Math.floor(Number(b.pendingRecords) || 0)),
  };
  await sql`update devices set last_seen_at = now(), connector_version = coalesce(${str(b.connectorVersion, 40)}, connector_version),
                               status = ${sql.json(status)} where id = ${dev.id}`;
  const [t] = await sql`select years_to_sync from tenants where id = ${dev.tenantId}`;
  const [c] = await sql`select min(sync_interval_sec)::int as s from companies where tenant_id = ${dev.tenantId}`;
  return json({ syncIntervalSec: c?.s ?? 300, yearsToSync: t?.years_to_sync ?? 3 });
});
