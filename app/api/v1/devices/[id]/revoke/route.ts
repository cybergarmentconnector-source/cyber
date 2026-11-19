import { requireOwner } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { fail, json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const s = await requireOwner(req);
  const { id } = await ctx.params;
  if (!UUID.test(id)) fail(404, 'not_found', 'Device not found.');
  const r = await sql`update devices set revoked_at = now() where id = ${id} and tenant_id = ${s.tenantId} and revoked_at is null returning id`;
  if (!r.length) fail(404, 'not_found', 'Device not found or already removed.');
  return json({ ok: true });
});
