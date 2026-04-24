import { NextRequest, NextResponse } from 'next/server';
import { fetchExecStats, fetchExecStatsFromInflux, downsample, summarize } from '@/lib/execStats';

export const dynamic = 'force-dynamic';

const RANGE_SECONDS: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '12h': 43200,
  '24h': 86400,
  '7d': 604800,
};

// Max points to return per range — keeps chart render snappy.
const MAX_POINTS: Record<string, number> = {
  '5m': 750, '15m': 900, '1h': 720, '6h': 720, '12h': 720, '24h': 720, '7d': 720,
};

// Ranges ≤ this threshold use Loki directly (freshest data, no sync lag from
// the InfluxDB writer). Wider ranges read persisted data from InfluxDB.
const LOKI_MAX_SECONDS = 900;

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '15m';
  if (!(range in RANGE_SECONDS)) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }

  const seconds = RANGE_SECONDS[range];
  try {
    let raw;
    let source: 'loki' | 'influx' = 'loki';
    if (seconds <= LOKI_MAX_SECONDS) {
      raw = await fetchExecStats(seconds, 5000);
    } else {
      source = 'influx';
      raw = await fetchExecStatsFromInflux(seconds);
      // Fallback to Loki if Influx is empty (e.g. writer just started and has
      // no data yet) — we can at least serve the last 15min of data.
      if (raw.length === 0) {
        source = 'loki';
        raw = await fetchExecStats(Math.min(seconds, LOKI_MAX_SECONDS), 5000);
      }
    }
    const points = downsample(raw, MAX_POINTS[range]);
    const summary = summarize(raw);

    return NextResponse.json({ range, source, summary, points }, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
