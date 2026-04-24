import { NextRequest, NextResponse } from 'next/server';
import { getTopContractsCached } from '@/lib/topContracts';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

const WINDOW_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600,
};

// Request timeout — generous because the first (uncached) call of a window
// does N batched RPC calls. Subsequent calls in TTL window are instant.
export const maxDuration = 60;

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

  const min = Math.max(1, Math.min(100, parseInt(req.nextUrl.searchParams.get('min') ?? '5', 10)));
  const limit = Math.max(1, Math.min(100, parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10)));

  try {
    const data = await getTopContractsCached(network, windowSeconds, min, limit);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
