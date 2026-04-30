import { NextRequest, NextResponse } from 'next/server';
import { getTopContractsCached, fetchTopContractsFromInflux, WINDOW_DEFAULT_MIN } from '@/lib/topContracts';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

const WINDOW_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600,
};

// Request timeout — generous because the live-compute fallback path can
// take 25-60s when the WS ring doesn't cover the requested window. The
// background writer (tickTopContractsWriter) populates InfluxDB every 60s
// so most user requests hit the InfluxDB path and complete in <100ms.
export const maxDuration = 60;

// How stale a stored snapshot can be before we prefer to recompute live.
// Snapshot writes happen every ~60s, so 5min is 5x safety margin. If the
// background writer is broken (validator down, etc) we serve a slightly
// stale result rather than block the user request.
const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  const rawNet = req.nextUrl.searchParams.get('network') ?? 'testnet';
  if (!(rawNet in NETWORKS) || !NETWORKS[rawNet as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = rawNet as NetworkId;

  const windowKey = req.nextUrl.searchParams.get('window') ?? '15m';
  const windowSeconds = WINDOW_SECONDS[windowKey];
  if (!windowSeconds) {
    return NextResponse.json(
      { error: `Invalid window — use one of ${Object.keys(WINDOW_SECONDS).join(',')}` },
      { status: 400 },
    );
  }

  const defaultMin = WINDOW_DEFAULT_MIN[windowKey] ?? 20;
  const min = Math.max(1, Math.min(500, parseInt(req.nextUrl.searchParams.get('min') ?? String(defaultMin), 10)));
  const limit = Math.max(1, Math.min(100, parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10)));

  try {
    // Primary path: read latest snapshot from InfluxDB. <100ms typically.
    // Only valid for the per-window default min + limit=20 (the params the
    // writer uses); custom min/limit fall through to live compute.
    if (min === defaultMin && limit === 20) {
      const snap = await fetchTopContractsFromInflux(network, windowKey);
      if (snap && snap.ageMs < SNAPSHOT_MAX_AGE_MS) {
        return NextResponse.json({ ...snap.result, source: 'influx', snapshotAgeMs: snap.ageMs }, {
          headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
        });
      }
    }
    // Fallback: live compute (also feeds the in-memory 60s cache for next callers).
    const data = await getTopContractsCached(network, windowSeconds, min, limit);
    return NextResponse.json({ ...data, source: 'live' }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
