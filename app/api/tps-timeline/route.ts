import { NextRequest, NextResponse } from 'next/server';
import { getTpsTimeline, getTpsCollectorState } from '@/lib/tpsTimeline';

export const dynamic = 'force-dynamic';

// Per-second TPS. Source = background block collector (1s tick) that fetches
// new Monad blocks via RPC and buckets tx counts by block timestamp (unix sec).
// Retention in memory = 1h, so 5m/15m/1h ranges are all served from RAM.
const RANGE_SEC: Record<string, number> = {
  '5m':  300,
  '15m': 900,
  '1h':  3600,
  '6h':  21600,
  '12h': 43200,
  '24h': 86400,
};

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '5m';
  const sec = RANGE_SEC[range];
  if (!sec) {
    return NextResponse.json(
      { error: 'range must be one of 5m, 15m, 1h, 6h, 12h, 24h' },
      { status: 400 },
    );
  }

  const state = getTpsCollectorState();
  // Target 600 bars per chart. For sec <= 600 we return `sec` bars at 1s each
  // (physical limit — block.timestamp has 1s resolution).
  const points = getTpsTimeline(sec, 600);

  return NextResponse.json({
    range,
    points,          // [{ts: unix_sec, tps: number}]  — one per second
    count: points.length,
    collector: {
      lastSeenBlock: state.lastSeenBlock,
      bucketCount: state.bucketCount,
      lastTickAgeSec: state.lastTickTs
        ? Math.floor((Date.now() - state.lastTickTs) / 1000)
        : null,
    },
  });
}
