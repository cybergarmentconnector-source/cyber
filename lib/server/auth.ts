import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './db';
import { fail } from './http';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, o: { N: number; r: number; p: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1;

/* ---- passwords: scrypt, stored as  scrypt$N$r$p$salt$hash  (create-user.mjs writes the same format) ---- */
export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string | null | undefined) {
  const [alg, n, r, p, s, h] = (stored ?? '').split('$');
  if (alg !== 'scrypt' || !s || !h) { await scrypt(pw, Buffer.alloc(16), 64, { N, r: R, p: P }); return false; }   // keeps timing similar
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length, { N: +n, r: +r, p: +p });
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ---- tokens ---- */
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Session tokens are stored as HMAC-SHA256(SESSION_SECRET, token). */
export function sessionHash(token: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET is not set (use a random string of 32+ characters)');
  return createHmac('sha256', secret).update(token).digest('hex');
}

export const SESSION_COOKIE = 'br_session';
export const SESSION_DAYS = 30;

export function cookieOf(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export interface Session { userId: string; name: string; email: string; role: 'owner' | 'viewer'; tenantId: string; tenantName: string }

export async function requireUser(req: Request): Promise<Session> {
  const token = cookieOf(req, SESSION_COOKIE);
  if (!token) return fail(401, 'unauthorized', 'Please sign in.');
  const [row] = await sql`
    select u.id, u.name, u.email, u.role, u.tenant_id, t.name as tenant_name
      from sessions s join users u on u.id = s.user_id join tenants t on t.id = u.tenant_id
     where s.token_hash = ${sessionHash(token)} and s.expires_at > now()`;
  if (!row) return fail(401, 'unauthorized', 'Your session has ended. Please sign in again.');
  return { userId: row.id, name: row.name, email: row.email, role: row.role, tenantId: row.tenant_id, tenantName: row.tenant_name };
}
export async function requireOwner(req: Request) {
  const s = await requireUser(req);
  if (s.role !== 'owner') fail(403, 'forbidden', 'Only the account owner can do this.');
  return s;
}

/** A company the signed-in user may read (404 otherwise, so ids of other tenants are never confirmed). */
export async function requireCompany(s: Session, cid: string) {
  const [c] = await sql`select * from companies where id = ${cid} and tenant_id = ${s.tenantId}`;
  if (!c) return fail(404, 'not_found', 'Company not found.');
  return c;
}

export interface Device { id: string; tenantId: string; name: string }
export async function requireDevice(req: Request): Promise<Device> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) return fail(401, 'unauthorized', 'Missing device token.');
  const [d] = await sql`select id, tenant_id, name from devices where token_hash = ${sha256(m[1])} and revoked_at is null`;
  if (!d) return fail(401, 'unauthorized', 'This device is not paired or was removed. Pair it again from the website.');
  return { id: d.id, tenantId: d.tenant_id, name: d.name };
}

/* ---- pairing codes: 8 characters, no look-alikes (no 0/O, 1/I/L) ---- */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newPairingCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const normalizeCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---- login throttle (best effort, per server instance) ---- */
const fails = new Map<string, { n: number; until: number }>();
export function throttled(key: string) { const f = fails.get(key); return !!f && f.n >= 8 && f.until > Date.now(); }
export function noteFail(key: string) { const f = fails.get(key); fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 }); }
export function clearFails(key: string) { fails.delete(key); }
