import { NextResponse } from 'next/server';
import { getMonitoringCatalog } from '@/lib/monitoringCatalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await getMonitoringCatalog();
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
}
