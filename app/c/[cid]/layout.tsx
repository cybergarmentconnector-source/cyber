'use client';
import { use, useEffect } from 'react';
import { AppShell } from '@/components/shell';

export default function CompanyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ cid: string }> }) {
  const { cid } = use(params);
  useEffect(() => { try { localStorage.setItem('lastCompany', cid); } catch {} }, [cid]);
  return <AppShell cid={cid}>{children}</AppShell>;
}
