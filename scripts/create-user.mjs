#!/usr/bin/env node
// Creates the first tenant + owner (or adds a user to an existing tenant).
//
//   DATABASE_URL=... node scripts/create-user.mjs --tenant "My Business" --email you@example.com --name "Your Name"
//   (password is asked on the terminal, or pass PASSWORD=... in the environment)
//   Add another user:   ... --tenant-id <uuid> --role viewer --email other@example.com --name "Other"
import postgres from 'postgres';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import readline from 'node:readline';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (v, what) => { if (!v) { console.error(`Missing ${what}. See the comment at the top of scripts/create-user.mjs.`); process.exit(1); } return v; };

async function hashPassword(pw) {            // same format as lib/server/auth.ts
  const N = 16384, r = 8, p = 1, salt = randomBytes(16);
  const h = await promisify(scrypt)(pw, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput; let muted = false;
    rl._writeToOutput = (s) => { if (!muted || s.includes('\n')) write.call(rl, s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    muted = true;
  });
}

const url = need(process.env.DATABASE_URL, 'DATABASE_URL (the Supabase pooler connection string)');
const email = need(arg('email'), '--email').trim().toLowerCase();
const name = need(arg('name'), '--name');
const role = arg('role') ?? 'owner';
if (!['owner', 'viewer'].includes(role)) { console.error('--role must be owner or viewer'); process.exit(1); }
const password = process.env.PASSWORD ?? await askHidden('Password (min 10 characters): ');
if (password.length < 10) { console.error('The password must be at least 10 characters.'); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  let tenantId = arg('tenant-id');
  if (!tenantId) {
    const [t] = await sql`insert into tally.tenants (name) values (${need(arg('tenant'), '--tenant (business name)')}) returning id`;
    tenantId = t.id;
  } else {
    const [t] = await sql`select id from tally.tenants where id = ${tenantId}`;
    if (!t) { console.error('No tenant with that id.'); process.exit(1); }
  }
  const [u] = await sql`insert into tally.users (tenant_id, email, name, password_hash, role)
                        values (${tenantId}, ${email}, ${name}, ${await hashPassword(password)}, ${role}) returning id`;
  console.log(`Created ${role} ${email}\n  tenant id: ${tenantId}\n  user id:   ${u.id}`);
} catch (e) {
  console.error(e.code === '23505' ? 'That email already has an account.' : `Could not create the user: ${e.message}`);
  process.exitCode = 1;
} finally { await sql.end(); }
