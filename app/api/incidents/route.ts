import { NextRequest, NextResponse } from 'next/server';
import { getIncidentFeedCached, Severity } from '@/lib/incidents';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RANGE_SECONDS: Record<string, number> = {
  '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800,
};
const ALLOWED_SEVERITY = new Set(['info', 'warn', 'critical']);

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '6h';
  if (!(range in RANGE_SECONDS)) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }
  const sevRaw = req.nextUrl.searchParams.get('severity');
  const severity = sevRaw && ALLOWED_SEVERITY.has(sevRaw) ? sevRaw as Severity : undefined;

  try {
    const data = await getIncidentFeedCached(RANGE_SECONDS[range], severity);
    return NextResponse.json({ range, ...data }, {
      headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
