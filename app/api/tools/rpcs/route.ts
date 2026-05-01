import { NextResponse } from 'next/server';
import { getRpcSnapshot } from '@/lib/rpcMonitor';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snap = getRpcSnapshot();
  return NextResponse.json(snap, {
    headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' },
  });
}
