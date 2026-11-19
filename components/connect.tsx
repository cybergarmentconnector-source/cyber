'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/* One-tap connector setup.
   "Connect Tally" creates a single-use pairing code and opens  tallycloud://connect?server=…&code=…&site=…
   The Windows connector (installed with the tallycloud:// link) pairs itself, finds Tally, picks the open companies and syncs.
   This component then waits until the new device shows up in /v1/devices. */

const DOWNLOAD_URL = process.env.NEXT_PUBLIC_CONNECTOR_DOWNLOAD_URL || '/downloads/TallyCloudConnector-Setup.exe';

// idle → (click) starting → waiting → done.  With `prepare`, the code is made on load (ready) and the click only opens the app:
// browsers open app links only straight after a click, so the click must not wait for the network.
type Phase = 'idle' | 'starting' | 'ready' | 'waiting' | 'done' | 'error';
type Code = { code: string; expiresAt: string };

export function ConnectTally({ prepare = false, label = 'Connect Tally', onConnected }: { prepare?: boolean; label?: string; onConnected?: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [code, setCode] = useState<Code | null>(null);
  const [err, setErr] = useState('');
  const [device, setDevice] = useState('');
  const [noApp, setNoApp] = useState(false);          // nothing seemed to open: make the download the main action
  const known = useRef<Set<string>>(new Set());
  const link = useRef('');
  const started = useRef(false);
  const done = useRef(onConnected);
  done.current = onConnected;

  const open = useCallback(() => {
    if (!link.current) return;
    setNoApp(false);
    let left = false;
    const away = () => { left = true; };
    window.addEventListener('blur', away, { once: true });
    document.addEventListener('visibilitychange', away, { once: true });
    window.location.href = link.current;
    window.setTimeout(() => {
      window.removeEventListener('blur', away); document.removeEventListener('visibilitychange', away);
      if (!left) setNoApp(true);
    }, 3500);
  }, []);

  const start = useCallback(async (launch: boolean) => {
    setErr(''); setDevice(''); setPhase('starting');
    try {
      const before = await api<{ devices: { id: string }[] }>('/v1/devices');
      known.current = new Set(before.devices.map(d => d.id));
      const c = await api<Code>('/v1/pairing-codes', { method: 'POST' });
      const server = process.env.NEXT_PUBLIC_CONNECTOR_SERVER || `${location.origin}/api`;
      link.current = `tallycloud://connect?server=${encodeURIComponent(server)}&code=${encodeURIComponent(c.code)}&site=${encodeURIComponent(location.origin)}`;
      setCode(c);
      if (launch) { setPhase('waiting'); open(); } else setPhase('ready');
    } catch (e: any) { setErr(e.message); setPhase('error'); }
  }, [open]);

  useEffect(() => { if (prepare && !started.current) { started.current = true; start(false); } }, [prepare, start]);

  // Wait for the connector to pair: a device that was not there before appears.
  useEffect(() => {
    if ((phase !== 'waiting' && phase !== 'ready') || !code) return;
    const until = new Date(code.expiresAt).getTime();
    const t = window.setInterval(async () => {
      if (Date.now() > until) { window.clearInterval(t); setErr('The setup link expired. Click the button to try again.'); setPhase('error'); return; }
      try {
        const now = await api<{ devices: { id: string; name: string; revokedAt: string | null }[] }>('/v1/devices');
        const fresh = now.devices.find(d => !known.current.has(d.id) && !d.revokedAt);
        if (fresh) { window.clearInterval(t); setDevice(fresh.name); setPhase('done'); done.current?.(); }
      } catch { /* keep waiting */ }
    }, 2000);
    return () => window.clearInterval(t);
  }, [phase, code]);

  if (phase === 'done') return (
    <div className="connect-box ok" role="status">
      <span className="connect-ic" aria-hidden="true">✓</span>
      <div><b>Connected “{device}”.</b><div className="muted">The first sync is running. Your reports appear here in a minute or two, and stay up to date by themselves.</div></div>
    </div>);

  if (phase === 'waiting' || phase === 'starting') return (
    <div className="connect-box" role="status" aria-live="polite">
      <span className="connect-spin" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <b>{phase === 'starting' ? 'Preparing…' : noApp ? 'Didn’t open?' : 'Finishing setup in Tally Cloud Connector…'}</b>
        <div className="muted">{noApp
          ? 'If your browser is asking, choose “Open Tally Cloud Connector”. If nothing appeared, the connector isn’t installed on this PC yet: download and run it, then press “Connect again”.'
          : 'If your browser asks, choose “Open Tally Cloud Connector”. This page updates by itself when the PC is connected.'}</div>
        <div className="connect-actions">
          {noApp
            ? <><a className="btn primary" href={DOWNLOAD_URL} download>Download connector</a><button className="btn" onClick={open} disabled={phase !== 'waiting'}>Connect again</button></>
            : <><button className="btn" onClick={open} disabled={phase !== 'waiting'}>Open again</button><a className="btn ghost" href={DOWNLOAD_URL} download>Download connector</a></>}
        </div>
        {code && <div className="small muted" style={{ marginTop: 10 }}>Setting up another PC? Type this code in its connector: <b className="tnum" style={{ letterSpacing: 1.5, color: 'var(--text)' }}>{code.code}</b> · valid until {new Date(code.expiresAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</div>}
      </div>
    </div>);

  if (phase === 'ready') return (
    <div>
      <button className="btn primary connect-btn" onClick={() => { setPhase('waiting'); open(); }} autoFocus>Open Tally Cloud Connector</button>
      <div className="small muted" style={{ marginTop: 8 }}>Not installed yet? <a href={DOWNLOAD_URL} download>Download the connector</a>, run it, then press the button.</div>
    </div>);

  return (
    <div>
      <button className="btn primary connect-btn" onClick={() => start(true)}>{phase === 'error' ? 'Try again' : label}</button>
      {phase === 'error'
        ? <div className="notice err" role="alert" style={{ marginTop: 12 }}><span aria-hidden="true">✕</span><div>{err}</div></div>
        : <div className="small muted" style={{ marginTop: 8 }}>Sets up the Windows PC that has Tally, in one step.</div>}
    </div>);
}
