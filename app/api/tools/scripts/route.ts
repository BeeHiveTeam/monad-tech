import { NextResponse } from 'next/server';
import { getScriptsCatalog } from '@/lib/scriptsCatalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await getScriptsCatalog();
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
}
