import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;

  try {
    // Fetch 20 latest blocks — 2 pages × 10/page covers 95% of casual browsing.
    // Power users paginating past page 2 still get cached response. Dropped from
    // 100 to reduce monad-rpc internal WARN amplification (each method call
    // generates ~12 internal channel-sends; 100 methods/batch was dominant).
    // `full=false` — we only need `transactions.length` for txCount.
    const rawBlocks = await getLatestBlocksBatched(network, 20, false) as Array<{
      number: string;
      timestamp: string;
      transactions: unknown[];
      gasUsed: string;
      gasLimit: string;
      miner: string;
      hash: string;
      size: string;
    }>;
    const blocks = rawBlocks.map((b) => ({
      number: parseInt(b.number, 16),
      timestamp: parseInt(b.timestamp, 16),
      txCount: Array.isArray(b.transactions) ? b.transactions.length : 0,
      gasUsed: parseInt(b.gasUsed, 16),
      gasLimit: parseInt(b.gasLimit, 16),
      miner: b.miner,
      hash: b.hash,
      size: parseInt(b.size, 16),
    }));

    // Blocks change every ~0.4s; let the edge cache briefly and serve stale
    // while revalidating in the background. Browser always revalidates.
    return NextResponse.json({ blocks }, {
      headers: {
        'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
