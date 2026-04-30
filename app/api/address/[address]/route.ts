import { NextRequest, NextResponse } from 'next/server';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded } from '@/lib/validator-registry';
import { getLatestBlocks } from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

function getRpcUrl(network: NetworkId): string {
  if (network === 'testnet' && process.env.MONAD_RPC_URL) return process.env.MONAD_RPC_URL;
  return NETWORKS[network].rpc;
}

async function batchRpc(url: string, calls: { method: string; params: unknown[] }[]): Promise<(unknown | null)[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json() as { id: number; result?: unknown; error?: unknown }[];
  const out: (unknown | null)[] = new Array(calls.length).fill(null);
  for (const item of j) out[item.id] = item.error ? null : item.result ?? null;
  return out;
}

const HEX = /^0x[0-9a-fA-F]+$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const addr = address.toLowerCase();

  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return NextResponse.json({ error: 'invalid address (must be 0x-prefixed 40-hex)' }, { status: 400 });
  }

  const network = (req.nextUrl.searchParams.get('network') ?? 'testnet') as NetworkId;
  const rpcUrl = getRpcUrl(network);

  try {
    // Make sure registry data is available so validator detection works.
    await ensureRegistryLoaded(rpcUrl).catch(() => { /* non-fatal */ });

    // Three RPC calls in one batch — balance, code, nonce.
    const [balanceHex, codeHex, nonceHex] = await batchRpc(rpcUrl, [
      { method: 'eth_getBalance', params: [addr, 'latest'] },
      { method: 'eth_getCode', params: [addr, 'latest'] },
      { method: 'eth_getTransactionCount', params: [addr, 'latest'] },
    ]);

    const balanceWei = balanceHex && HEX.test(balanceHex as string) ? BigInt(balanceHex as string) : BigInt(0);
    const balanceMon = Number(balanceWei) / 1e18;
    const code = (codeHex as string) ?? '0x';
    const nonce = nonceHex && HEX.test(nonceHex as string) ? Number(BigInt(nonceHex as string)) : 0;

    const isContract = code !== '0x' && code !== '0x0';
    const codeSize = isContract ? Math.floor((code.length - 2) / 2) : 0;

    // Validator registry lookup — does this address appear in the staking
    // precompile / GitHub registry?
    const validatorInfo = getValidatorInfo(addr);

    // Recent ring activity — show blocks where this address was the miner,
    // and txs where it was sender or receiver. Lightweight: scans the RAM
    // ring (typically 9000 blocks ≈ 1h on Monad testnet).
    const ring = getLatestBlocks(200);
    const minedBlocks: { number: number; timestamp: number; txCount: number }[] = [];
    const recentTxs: { hash: string; blockNumber: number; from: string; to: string | null; valueMon: string; direction: 'in' | 'out' | 'self' }[] = [];

    for (const b of ring) {
      if (!b) continue;
      if ((b.miner ?? '').toLowerCase() === addr) {
        minedBlocks.push({
          number: b.number,
          timestamp: b.timestamp,
          txCount: b.txCount ?? (b.txs?.length ?? 0),
        });
      }
      if (Array.isArray(b.txs)) {
        for (const tx of b.txs) {
          const from = (tx.from ?? '').toLowerCase();
          const to = (tx.to ?? '').toLowerCase();
          if (from !== addr && to !== addr) continue;
          if (recentTxs.length >= 50) break;
          const valBI = tx.value && HEX.test(tx.value) ? BigInt(tx.value) : BigInt(0);
          recentTxs.push({
            hash: tx.hash,
            blockNumber: b.number,
            from,
            to: tx.to ?? null,
            valueMon: (Number(valBI) / 1e18).toFixed(6),
            direction: from === addr && to === addr ? 'self' : from === addr ? 'out' : 'in',
          });
        }
      }
    }
    minedBlocks.sort((a, b) => b.number - a.number);
    recentTxs.sort((a, b) => b.blockNumber - a.blockNumber);

    return NextResponse.json({
      address: addr,
      network,
      balanceMon,
      isContract,
      codeSize,
      nonce,
      validator: validatorInfo
        ? {
            registered: true,
            moniker: validatorInfo.moniker,
            validatorId: validatorInfo.validatorId ?? null,
            stakeMon: validatorInfo.stakeMon ?? null,
            commissionPct: validatorInfo.commissionPct ?? null,
            website: validatorInfo.website ?? null,
            description: validatorInfo.description ?? null,
            x: validatorInfo.x ?? null,
          }
        : null,
      minedBlocks: minedBlocks.slice(0, 20),
      recentTxs: recentTxs.slice(0, 20),
      ringSize: ring.length,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err), address: addr }, { status: 500 });
  }
}

