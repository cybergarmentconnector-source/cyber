'use client';
import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RouteSkeleton } from '@/components/shell';

export default function Index({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = use(params);
  const router = useRouter();
  useEffect(() => { router.replace(`/c/${cid}/dashboard`); }, [cid, router]);
  return <RouteSkeleton />;
}
