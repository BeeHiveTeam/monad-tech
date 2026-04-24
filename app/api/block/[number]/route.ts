import { NextRequest, NextResponse } from 'next/server';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

function getRpcUrl(network: NetworkId): string {
  if (network === 'testnet' && process.env.MONAD_RPC_URL) return process.env.MONAD_RPC_URL;
  return NETWORKS[network].rpc;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json() as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gas: string;
  gasPrice: string;
}

interface RpcBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  miner: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas?: string;
  size: string;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  extraData: string;
  transactions: RpcTx[];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ number: string }> }) {
  const { number } = await ctx.params;
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;
  const url = getRpcUrl(network);

  // Accept either decimal (27164313) or hex (0x19e5b99). Also "latest" shortcut.
  let tag: string;
  if (number === 'latest') tag = 'latest';
  else if (/^\d+$/.test(number)) tag = '0x' + BigInt(number).toString(16);
  else if (/^0x[0-9a-fA-F]+$/.test(number)) tag = number;
  else return NextResponse.json({ error: 'Invalid block number' }, { status: 400 });

  try {
    const block = await rpc(url, 'eth_getBlockByNumber', [tag, true]) as RpcBlock | null;
    if (!block) return NextResponse.json({ error: 'Block not found' }, { status: 404 });

    const toBig = (h?: string | null) => h ? BigInt(h) : BigInt(0);
    const toNum = (h?: string | null) => h ? parseInt(h, 16) : null;
    const gasUsed = toBig(block.gasUsed);
    const gasLimit = toBig(block.gasLimit);
    const baseFee = toBig(block.baseFeePerGas);
    const utilPct = gasLimit > BigInt(0)
      ? Number((gasUsed * BigInt(10000)) / gasLimit) / 100
      : 0;

    const txs = (block.transactions || []).map(t => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      valueMon: (Number(toBig(t.value)) / 1e18).toFixed(6),
      gasPriceGwei: (Number(toBig(t.gasPrice)) / 1e9).toFixed(4),
    }));

    return NextResponse.json({
      number: toNum(block.number),
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: toNum(block.timestamp),
      miner: block.miner,
      gasUsed: Number(gasUsed),
      gasLimit: Number(gasLimit),
      gasUtilPct: utilPct,
      baseFeeGwei: baseFee > BigInt(0) ? (Number(baseFee) / 1e9).toFixed(4) : null,
      size: toNum(block.size),
      stateRoot: block.stateRoot,
      transactionsRoot: block.transactionsRoot,
      receiptsRoot: block.receiptsRoot,
      extraData: block.extraData,
      txCount: txs.length,
      transactions: txs,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
