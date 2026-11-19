import { chunked, sql } from '@/lib/server/db';
import { body, bool, json, route } from '@/lib/server/http';
import { openRun, requireDevice } from '@/lib/server/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Publishes a run: marks removed vouchers, refreshes the pending-bill snapshot and the company's dates, bumps data_version. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const dev = await requireDevice(req);
  const { id } = await ctx.params;
  const run = await openRun(dev, id);
  const b = await body(req);
  const gone: string[] = Array.isArray(b.deleted?.voucher) ? b.deleted.voucher.map(String).slice(0, 200_000) : [];
  const extra: Record<string, unknown> = { deleted: { voucher: gone.length } };
  for (const k of ['held', 'durationMs', 'note']) if (b.stats && k in b.stats) extra[k] = b.stats[k];
  const cid = run.companyId;

  const version = await sql.begin(async tx => {
    await chunked(gone, 5000, p => tx`update vouchers set deleted = true where company_id = ${cid} and id = any(${p}::text[])`);
    if (bool(b.replaceBills)) await tx`delete from bills where company_id = ${cid} and run_id is distinct from ${run.id}::uuid`;
    await tx`update companies set
               first_voucher_date = (select min(date) from vouchers where company_id = ${cid} and not deleted),
               last_voucher_date  = (select max(date) from vouchers where company_id = ${cid} and not deleted)
             where id = ${cid}`;
    const [{ v }] = await tx`select next_data_version(${cid}) as v`;
    await tx`update sync_runs set status = 'committed', finished_at = now(), stats = stats || ${sql.json(extra as any)} where id = ${run.id}`;
    return v as string;
  });
  return json({ ok: true, dataVersion: version });
});
