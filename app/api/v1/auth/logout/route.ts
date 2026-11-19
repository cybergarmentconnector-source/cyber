import { cookieOf, SESSION_COOKIE, sessionHash } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req: Request) => {
  const token = cookieOf(req, SESSION_COOKIE);
  if (token) await sql`delete from sessions where token_hash = ${sessionHash(token)}`;
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
});
