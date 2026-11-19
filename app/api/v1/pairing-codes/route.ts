import { newPairingCode, requireOwner } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req: Request) => {
  const s = await requireOwner(req);
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await sql`delete from pairing_codes where expires_at < now() - interval '1 day'`;
  for (let i = 0; i < 5; i++) {
    const code = newPairingCode();
    const r = await sql`insert into pairing_codes (code, tenant_id, expires_at) values (${code}, ${s.tenantId}, ${expiresAt}) on conflict do nothing returning code`;
    if (r.length) return json({ code, expiresAt });
  }
  throw new Error('could not allocate a pairing code');
});
