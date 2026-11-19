import { newToken, normalizeCode, sha256 } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { body, fail, json, route, str } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const code = normalizeCode(b.code);
  const name = str(b.deviceName, 120) ?? 'Windows PC';
  const version = str(b.connectorVersion, 40);
  if (code.length !== 8) fail(400, 'invalid_code', 'That code is not valid. Codes have 8 letters and numbers.');

  const token = newToken();
  const deviceId = await sql.begin(async tx => {
    const [c] = await tx`update pairing_codes set used_at = now()
                          where code = ${code} and used_at is null and expires_at > now() returning tenant_id`;
    if (!c) return fail(400, 'invalid_code', 'That code is wrong, already used, or expired. Create a new one on the website.');
    const [d] = await tx`insert into devices (tenant_id, name, token_hash, connector_version, last_seen_at)
                          values (${c.tenant_id}, ${name}, ${sha256(token)}, ${version}, now()) returning id`;
    return d.id as string;
  });
  return json({ deviceId, token });
});
