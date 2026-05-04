import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getLatestBlocks as getRingBlocks } from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;

  try {
    // Primary path: read 20 latest blocks from the WebSocket-driven ring buffer.
    // Each block was pushed via eth_subscribe(newHeads) and enriched with txCount
    // via a single eth_getBlockByNumber(num, false). Zero RPC calls at request
    // time — the heavy lifting is done by the background stream.
    //
    // The ring buffer is filled by our testnet WS subscription only —
    // bypass it for mainnet (we'd serve testnet block numbers under the
    // mainnet view otherwise — confusing-looking "stale" data on the
    // Latest Blocks table).
    const ring = network === 'testnet' ? getRingBlocks(20) : [];
    if (ring.length >= 20) {
      const blocks = ring.map(b => ({
        number: b.number,
        timestamp: b.timestamp,
        txCount: b.txCount ?? 0,
        gasUsed: b.gasUsed,
        gasLimit: b.gasLimit,
        miner: b.miner,
        hash: b.hash,
        size: b.size,
      }));
      return NextResponse.json({ blocks, source: 'ws-ring' }, {
        headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' },
      });
    }

    // Fallback path: ring not yet warm (PM2 restart, ws not yet connected).
    // Falls back to RPC batch fetch — same behavior as pre-WS migration.
    const rawBlocks = await getLatestBlocksBatched(network, 20, false) as Array<{
      number: string; timestamp: string; transactions: unknown[];
      gasUsed: string; gasLimit: string; miner: string; hash: string; size: string;
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
    return NextResponse.json({ blocks, source: 'rpc-fallback' }, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
