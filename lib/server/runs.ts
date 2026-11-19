import { requireDevice, type Device } from './auth';
import { sql } from './db';
import { fail } from './http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An open sync run that belongs to the calling device's account. */
export async function openRun(dev: Device, id: string) {
  if (!UUID.test(id)) return fail(404, 'not_found', 'Run not found.');
  const [r] = await sql`
    select r.id, r.company_id, r.status from sync_runs r join companies c on c.id = r.company_id
     where r.id = ${id} and c.tenant_id = ${dev.tenantId}`;
  if (!r) return fail(404, 'not_found', 'Run not found.');
  if (r.status !== 'open') return fail(409, 'run_closed', `This sync run is already ${r.status}. Start a new run.`);
  return { id: r.id as string, companyId: r.company_id as string };
}
export { requireDevice };
