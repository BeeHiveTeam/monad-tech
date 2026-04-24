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
    // Scan 25 latest blocks — enough for first 2-3 pages on an active network.
    // Was 50; halved to reduce monad-rpc internal amplification. If blocks are
    // empty and we run short of txs, client still gets a response and paginates.
    // `full=true` because we need tx hash/from/to/value.
    const rawBlocks = await getLatestBlocksBatched(network, 25, true) as Array<{ transactions?: unknown[] }>;

    const txs: {
      hash: string;
      from: string;
      to: string | null;
      value: string;
      blockNumber: number;
      gasPrice: string;
    }[] = [];

    const MAX = 100;
    for (const block of rawBlocks) {
      if (!Array.isArray(block.transactions)) continue;
      for (const tx of block.transactions as {
        hash: string;
        from: string;
        to: string | null;
        value: string;
        blockNumber: string;
        gasPrice: string;
      }[]) {
        if (txs.length >= MAX) break;
        txs.push({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: (Number(BigInt(tx.value || '0x0')) / 1e18).toFixed(4),
          blockNumber: parseInt(tx.blockNumber, 16),
          gasPrice: (Number(BigInt(tx.gasPrice || '0x0')) / 1e9).toFixed(2),
        });
      }
      if (txs.length >= MAX) break;
    }

    return NextResponse.json({ transactions: txs }, {
      headers: {
        'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
