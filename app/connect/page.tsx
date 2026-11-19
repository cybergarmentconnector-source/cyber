'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ConnectTally } from '@/components/connect';

/** Opened by the connector's "Connect" button: signs in if needed, then sets up the PC straight away. */
export default function ConnectPage() {
  const [me, setMe] = useState<any>(null);
  useEffect(() => { api('/v1/me').then(setMe).catch(() => {}); }, []);
  return (
    <div className="login-wrap"><div className="login" style={{ width: 'min(460px, 100%)' }}>
      <h1>Connect Tally</h1>
      {!me ? <div role="status" aria-label="Loading"><div className="sk sk-line w70" /><div className="sk sk-line w55" /><div className="sk sk-ctl" style={{ width: 180, marginTop: 12 }} /></div>
        : me.user.role !== 'owner' ? <p className="muted">Only the account owner can connect a PC. Ask {me.tenant.name}’s owner to do this.</p>
        : (<>
          <p className="muted">Connecting this PC to <b>{me.tenant.name}</b>’s reports.</p>
          <ConnectTally prepare />
          <p style={{ marginTop: 18, marginBottom: 0 }}><a href="/">Go to reports →</a></p>
        </>)}
    </div></div>);
}
