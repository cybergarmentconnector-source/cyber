import { NextResponse } from 'next/server';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }

export const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  NextResponse.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** Wraps a route handler: HttpError -> { error, message } with its status; anything else -> 500. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try { return await fn(...args); }
    catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      console.error('[api]', e);
      return json({ error: 'server', message: 'The server could not complete this request. Please try again shortly.' }, 500);
    }
  };
}

export async function body<T = any>(req: Request): Promise<T> {
  try { const v = await req.json(); if (v && typeof v === 'object') return v as T; } catch { /* fall through */ }
  return fail(400, 'bad_request', 'The request body must be JSON.');
}

/* Small coercions for data coming from the connector. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUM = /^-?\d+(\.\d+)?$/;
export const str = (v: unknown, max = 500): string | null => (v == null || v === '' ? null : String(v).slice(0, max));
export const date = (v: unknown): string | null => (typeof v === 'string' && DATE.test(v) ? v : null);
export const bool = (v: unknown) => v === true || v === 'true' || v === 1;
export const num = (v: unknown, dflt = 0): string => {
  if (v == null || v === '') return String(dflt);
  const s = String(v).trim();
  return NUM.test(s) ? s : String(dflt);
};
export const numOrNull = (v: unknown): string | null => (v == null || v === '' ? null : num(v));
