import { requireUser } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request) => {
  const s = await requireUser(req);
  const rows = await sql`select id, name, last_seen_at, connector_version, revoked_at from devices
                          where tenant_id = ${s.tenantId} order by revoked_at is not null, last_seen_at desc nulls last, name`;
  return json({ devices: rows.map(d => ({ id: d.id, name: d.name, lastSeenAt: d.last_seen_at, connectorVersion: d.connector_version, revokedAt: d.revoked_at })) });
});
