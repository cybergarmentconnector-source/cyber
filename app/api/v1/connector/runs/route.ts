import { requireDevice } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { body, date, fail, json, route, str } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const KINDS = new Set(['full', 'incremental', 'reconcile']);

export const POST = route(async (req: Request) => {
  const dev = await requireDevice(req);
  const b = await body(req);
  const companyId = str(b.companyId, 200), name = str(b.companyName, 300), kind = String(b.kind ?? '');
  if (!companyId || !name) fail(400, 'bad_request', 'companyId and companyName are required.');
  if (!KINDS.has(kind)) fail(400, 'bad_request', 'kind must be full, incremental or reconcile.');
  const fy = Number(b.fyStartMonth); const fyMonth = fy >= 1 && fy <= 12 ? Math.floor(fy) : 4;

  const runId = await sql.begin(async tx => {
    const [c] = await tx`
      insert into companies (id, tenant_id, name, books_from, fy_start_month, base_currency, device_id, last_attempt_at, last_run_status)
      values (${companyId}, ${dev.tenantId}, ${name}, ${date(b.booksFrom)}, ${fyMonth}, ${str(b.baseCurrency, 10) ?? 'INR'}, ${dev.id}, now(), 'running')
      on conflict (id) do update set name = excluded.name, books_from = coalesce(excluded.books_from, companies.books_from),
        fy_start_month = excluded.fy_start_month, base_currency = excluded.base_currency, device_id = excluded.device_id,
        last_attempt_at = now(), last_run_status = 'running'
      where companies.tenant_id = excluded.tenant_id
      returning id`;
    if (!c) return fail(409, 'conflict', 'This company is already registered under another account.');
    await tx`update sync_runs set status = 'expired', finished_at = now() where company_id = ${companyId} and status = 'open'`;
    const [r] = await tx`insert into sync_runs (company_id, device_id, kind) values (${companyId}, ${dev.id}, ${kind}) returning id`;
    return r.id as string;
  });
  return json({ runId });
});
