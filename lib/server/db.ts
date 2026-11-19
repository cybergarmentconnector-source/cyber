import postgres from 'postgres';

/** One shared Postgres client per server instance. DATABASE_URL = the Supabase *pooler* connection string. */
const g = globalThis as unknown as { __tallySql?: postgres.Sql };

function create(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return postgres(url, {
    max: 5,
    prepare: false,            // required by the Supabase transaction pooler
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    // numeric / bigint stay strings (exact money); dates stay 'YYYY-MM-DD' strings (no timezone shifts)
    types: { date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x } },
    connection: { search_path: 'tally,public' },
  });
}

export const sql: postgres.Sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  get(_t, prop) { const c = (g.__tallySql ??= create()); const v = (c as any)[prop]; return typeof v === 'function' ? v.bind(c) : v; },
  apply(_t, _this, args) { const c = (g.__tallySql ??= create()); return (c as any)(...args); },
});

/** Run rows through a callback in chunks (Postgres allows ~65k bind parameters per statement). */
export async function chunked<T>(rows: T[], size: number, fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}
