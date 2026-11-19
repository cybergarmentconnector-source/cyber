import { requireUser } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request) => {
  const s = await requireUser(req);
  const rows = await sql`
    select id, name, books_from, fy_start_month, base_currency, last_published_at, last_attempt_at, last_error, data_version,
           first_voucher_date, last_voucher_date, sync_interval_sec, last_run_status
      from companies where tenant_id = ${s.tenantId} order by name`;
  return json({
    user: { id: s.userId, name: s.name, email: s.email, role: s.role },
    tenant: { name: s.tenantName },
    companies: rows.map(c => ({
      id: c.id, name: c.name, booksFrom: c.books_from, fyStartMonth: c.fy_start_month, baseCurrency: c.base_currency,
      lastPublishedAt: c.last_published_at, lastAttemptAt: c.last_attempt_at, lastError: c.last_error, dataVersion: c.data_version,
      firstVoucherDate: c.first_voucher_date, lastVoucherDate: c.last_voucher_date, syncIntervalSec: c.sync_interval_sec, lastRunStatus: c.last_run_status,
    })),
  });
});
