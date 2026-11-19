'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, peekApi, restorePersisted } from '@/lib/api';
import { ShellSkeleton } from '@/components/shell';

/** "/" opens the last company's dashboard. With the account saved by an earlier visit this happens at once; otherwise after it loads. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    try { last = localStorage.getItem('lastCompany'); } catch { /* storage blocked */ }
    const go = (me: any) => {
      const c = me.companies.find((x: any) => x.id === last) ?? me.companies[0];
      router.replace(c ? `/c/${c.id}/dashboard` : '/c/none/dashboard');
    };
    restorePersisted();
    const saved = peekApi('/v1/me');
    if (saved) { go(saved); return; }          // the shell refreshes the account right after
    api('/v1/me').then(go).catch(() => {});
  }, [router]);
  return <ShellSkeleton cid="" />;
}
