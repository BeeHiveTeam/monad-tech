import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiError';
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

  // Incident detectors read testnet-only InfluxDB. For mainnet there is no
  // public source yet — return an explicit coming-soon payload, never echo
  // testnet data under a mainnet request.
  const network = req.nextUrl.searchParams.get('network') ?? 'testnet';
  if (network === 'mainnet') {
    return NextResponse.json(
      { range, network: 'mainnet', comingSoon: true, events: [], counts: { info: 0, warn: 0, critical: 0 } },
      { headers: { 'Cache-Control': 'public, s-maxage=60' } },
    );
  }

  try {
    const data = await getIncidentFeedCached(RANGE_SECONDS[range], severity);
    return NextResponse.json({ range, ...data }, {
      headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' },
    });
  } catch (err) {
    return apiError(err, 500, 'incidents');
  }
}
