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
  nonce: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  value: string;
  gas: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
  chainId?: string;
  type?: string;
  v?: string;
  r?: string;
  s?: string;
}

interface RpcReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  gasUsed: string;
  cumulativeGasUsed: string;
  effectiveGasPrice?: string;
  contractAddress: string | null;
  status: string;   // 0x1 = success, 0x0 = failed
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    logIndex: string;
    transactionIndex: string;
    removed: boolean;
  }>;
  logsBloom: string;
  type: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;
  const url = getRpcUrl(network);

  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: 'Invalid tx hash format' }, { status: 400 });
  }

  try {
    const [txRaw, receiptRaw] = await Promise.all([
      rpc(url, 'eth_getTransactionByHash', [hash]) as Promise<RpcTx | null>,
      rpc(url, 'eth_getTransactionReceipt', [hash]) as Promise<RpcReceipt | null>,
    ]);

    if (!txRaw) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    // Fetch block for timestamp
    let blockTs: number | null = null;
    if (txRaw.blockNumber) {
      try {
        const block = await rpc(url, 'eth_getBlockByNumber', [txRaw.blockNumber, false]) as {
          timestamp: string;
        } | null;
        if (block?.timestamp) blockTs = parseInt(block.timestamp, 16);
      } catch { /* ignore */ }
    }

    const toBigInt = (h?: string | null) => h ? BigInt(h) : BigInt(0);
    const toNum    = (h?: string | null) => h ? parseInt(h, 16) : null;
    const valueWei = toBigInt(txRaw.value);
    const gasLimit = toBigInt(txRaw.gas);
    const gasPrice = toBigInt(txRaw.gasPrice);
    const gasUsed  = receiptRaw ? toBigInt(receiptRaw.gasUsed) : BigInt(0);
    const effGasPrice = receiptRaw?.effectiveGasPrice
      ? toBigInt(receiptRaw.effectiveGasPrice) : gasPrice;
    const feeWei = gasUsed * effGasPrice;

    return NextResponse.json({
      hash: txRaw.hash,
      status: receiptRaw ? (receiptRaw.status === '0x1' ? 'success' : 'failed') : 'pending',
      blockNumber: toNum(txRaw.blockNumber),
      blockHash: txRaw.blockHash,
      blockTimestamp: blockTs,
      transactionIndex: toNum(txRaw.transactionIndex),
      from: txRaw.from,
      to: txRaw.to,
      contractAddress: receiptRaw?.contractAddress ?? null,
      value: {
        wei: valueWei.toString(),
        mon: (Number(valueWei) / 1e18).toFixed(6),
      },
      nonce: toNum(txRaw.nonce),
      gas: {
        limit: toNum(txRaw.gas),
        used:  receiptRaw ? toNum(receiptRaw.gasUsed) : null,
        price_gwei: (Number(gasPrice) / 1e9).toFixed(4),
        effective_price_gwei: (Number(effGasPrice) / 1e9).toFixed(4),
        max_fee_gwei: txRaw.maxFeePerGas ? (Number(toBigInt(txRaw.maxFeePerGas)) / 1e9).toFixed(4) : null,
        max_priority_gwei: txRaw.maxPriorityFeePerGas ? (Number(toBigInt(txRaw.maxPriorityFeePerGas)) / 1e9).toFixed(4) : null,
        fee_mon: (Number(feeWei) / 1e18).toFixed(8),
        cumulative_used: receiptRaw ? toNum(receiptRaw.cumulativeGasUsed) : null,
      },
      input: txRaw.input,
      inputMethodId: txRaw.input && txRaw.input.length >= 10 ? txRaw.input.slice(0, 10) : null,
      type: txRaw.type,
      chainId: txRaw.chainId ? parseInt(txRaw.chainId, 16) : null,
      logs: receiptRaw?.logs.map(l => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        logIndex: toNum(l.logIndex),
      })) ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
