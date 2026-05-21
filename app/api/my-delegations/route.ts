import { NextRequest, NextResponse } from 'next/server';
import { rpcBatch } from '@/lib/rpc';
import { ensureRegistryLoaded, getChainDataById } from '@/lib/validator-registry';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { apiError } from '@/lib/apiError';

export const dynamic = 'force-dynamic';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const SEL_GET_DELEGATOR = '0x573c1ce0'; // getDelegator(uint64,address) → returns delegator's stake at this validator
const RPC_BATCH_SIZE = 25;

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const _cache = new Map<string, { ts: number; data: unknown }>();
const CACHE_TTL_MS = 60_000;

function pad32(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}
function encGetDelegator(validatorId: number, addr: string): string {
  return SEL_GET_DELEGATOR + pad32(validatorId.toString(16)) + pad32(addr.replace(/^0x/, ''));
}
function decodeStakeMon(raw: string): number {
  if (!raw || raw.length < 66) return 0;
  try { return Number(BigInt('0x' + raw.slice(2, 66))) / 1e18; } catch { return 0; }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawAddr = (sp.get('address') ?? '').toLowerCase();
  const rawNet = sp.get('network') ?? 'testnet';
  const network: NetworkId = (rawNet === 'mainnet' ? 'mainnet' : 'testnet');

  if (!ADDRESS_RE.test(rawAddr)) {
    return apiError(new Error('invalid address (expected 0x + 40 hex)'), 400, 'my-delegations/invalid');
  }

  const cacheKey = `${network}:${rawAddr}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
      ? process.env.MONAD_RPC_URL
      : NETWORKS[network].rpc;
    await ensureRegistryLoaded(rpcUrl, network);

    const chainData = getChainDataById(network);
    if (chainData.size === 0) {
      return NextResponse.json({
        network, address: rawAddr, building: true,
        message: 'Validator registry is still loading.',
        positions: [], totalStakeMon: 0, totalWeightedApr: 0,
        fetchedAt: Date.now(),
      });
    }

    // Build call list: getDelegator(vid, rawAddr) for every validator ID
    // in the registry. Each call returns the stake amount this delegator has
    // at that validator; we filter to non-zero.
    const ids = [...chainData.keys()];
    const calls = ids.map(id => ({
      method: 'eth_call',
      params: [{ to: STAKING_PRECOMPILE, data: encGetDelegator(id, rawAddr) }, 'latest'] as unknown[],
    }));

    // Batch ≤25 per RPC request (monad-rpc pacing rule). Sequential batches
    // with no extra pause — single-shot user request, low burst risk.
    const stakeByVid = new Map<number, number>();
    for (let i = 0; i < calls.length; i += RPC_BATCH_SIZE) {
      const slice = calls.slice(i, i + RPC_BATCH_SIZE);
      const idsSlice = ids.slice(i, i + RPC_BATCH_SIZE);
      let results: unknown[] = [];
      try {
        results = await rpcBatch(network, slice);
      } catch { continue; /* skip batch on error */ }
      results.forEach((r, k) => {
        const stake = decodeStakeMon(r as string);
        if (stake > 0.001) stakeByVid.set(idsSlice[k], stake);
      });
    }

    // Build position rows enriched with validator info
    type Position = {
      validatorId: number;
      authAddress: string;
      moniker: string | null;
      stakeMon: number;
      commissionPct: number | null;
      isActiveSet: boolean;
    };
    const positions: Position[] = [];
    for (const [vid, stake] of stakeByVid) {
      const chain = chainData.get(vid);
      if (!chain) continue;
      const info = getValidatorInfo(chain.authAddress, network);
      positions.push({
        validatorId: vid,
        authAddress: chain.authAddress,
        moniker: info?.moniker ?? null,
        stakeMon: stake,
        commissionPct: chain.commissionPct ?? null,
        isActiveSet: (chain.stakeMon ?? 0) > 0,
      });
    }
    positions.sort((a, b) => b.stakeMon - a.stakeMon);

    const totalStakeMon = positions.reduce((s, p) => s + p.stakeMon, 0);

    const data = {
      network,
      address: rawAddr,
      positionCount: positions.length,
      totalStakeMon,
      validatorsScanned: ids.length,
      positions,
      fetchedAt: Date.now(),
    };
    _cache.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err, 500, `my-delegations/${rawAddr}`);
  }
}
