import { clearFails, newToken, noteFail, SESSION_COOKIE, SESSION_DAYS, sessionHash, throttled, verifyPassword } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';
import { body, fail, json, route } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (req: Request) => {
  const b = await body(req);
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  const key = `${email}|${(req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()}`;
  if (throttled(key)) fail(429, 'too_many', 'Too many attempts. Please wait a few minutes and try again.');

  const [u] = await sql`select id, password_hash from users where lower(email) = ${email}`;
  const ok = await verifyPassword(password, u?.password_hash);
  if (!u || !ok) { noteFail(key); return fail(401, 'invalid', 'Wrong email or password'); }
  clearFails(key);

  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${sessionHash(token)}, ${u.id}, ${expires})`;
  await sql`delete from sessions where expires_at < now()`;

  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires });
  return res;
});
