'use client';
import { FormEvent, Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, clearApiCache } from '@/lib/api';

function LoginForm() {
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await api('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      clearApiCache();   // nothing saved from a previous account may show for this one
      const next = sp.get('next');
      location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <main className="login">
        <h1>Business Reports</h1>
        <p className="muted" style={{ margin: '4px 0 0' }}>Sign in to view your Tally reports.</p>
        <form onSubmit={submit}>
          <label className="field">Email<input name="email" type="email" autoComplete="username" required autoFocus /></label>
          <label className="field">Password<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <div className="notice err" role="alert"><span>✕</span><div>{error}</div></div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>
    </div>
  );
}
export default function Login() { return <Suspense><LoginForm /></Suspense>; }
