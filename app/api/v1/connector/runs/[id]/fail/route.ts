import { requireDevice } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { body, fail, json, route, str } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const dev = await requireDevice(req);
  const { id } = await ctx.params;
  if (!UUID.test(id)) fail(404, 'not_found', 'Run not found.');
  const b = await body(req).catch(() => ({} as any));
  const error = str(b.error, 1000) ?? 'The sync failed.';
  const [r] = await sql`
    update sync_runs set status = 'failed', finished_at = now(), error = ${error}
     where id = ${id} and status = 'open' and company_id in (select id from companies where tenant_id = ${dev.tenantId})
     returning company_id`;
  if (r) await sql`update companies set last_error = ${error}, last_run_status = 'failed', last_attempt_at = now() where id = ${r.company_id}`;
  return json({ ok: true });
});
