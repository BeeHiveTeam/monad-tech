import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getLatestBlocks as getRingBlocks } from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

interface OutTx {
  hash: string; from: string; to: string | null;
  value: string; blockNumber: number; gasPrice: string;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;

  try {
    const MAX = 100;

    // Primary path: read txs from the WebSocket ring buffer. Blocks are
    // pre-enriched via background eth_getBlockByNumber(num, true) on each push,
    // so tx data (from/to/value/gasPrice) is already in RAM.
    const ring = getRingBlocks(25);
    const ringHasFullTxs = ring.length >= 25 && ring.every(b => b.txs !== null);
    if (ringHasFullTxs) {
      const txs: OutTx[] = [];
      for (const block of ring) {
        if (!block.txs) continue;
        for (const t of block.txs) {
          if (txs.length >= MAX) break;
          txs.push({
            hash: t.hash,
            from: t.from,
            to: t.to,
            value: (Number(BigInt(t.value)) / 1e18).toFixed(4),
            blockNumber: t.blockNumber,
            gasPrice: (Number(BigInt(t.gasPrice)) / 1e9).toFixed(2),
          });
        }
        if (txs.length >= MAX) break;
      }
      return NextResponse.json({ transactions: txs, source: 'ws-ring' }, {
        headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' },
      });
    }

    // Fallback path (cold ring): fetch via RPC batch. Same as pre-WS migration.
    const rawBlocks = await getLatestBlocksBatched(network, 25, true) as Array<{ transactions?: unknown[] }>;
    const txs: OutTx[] = [];
    for (const block of rawBlocks) {
      if (!Array.isArray(block.transactions)) continue;
      for (const tx of block.transactions as {
        hash: string; from: string; to: string | null;
        value: string; blockNumber: string; gasPrice: string;
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
    return NextResponse.json({ transactions: txs, source: 'rpc-fallback' }, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
