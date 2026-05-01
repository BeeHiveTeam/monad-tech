import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getRegistryEntries, getConsensusIds, getChainDataById } from '@/lib/validator-registry';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getBlockCache, setBlockCache } from '@/lib/block-cache';
import { getValidatorIdForBlock, getBeneficiaryForValidator } from '@/lib/beneficiaryMap';
import { getMinerAggregate, getAggregateState } from '@/lib/wsBlockStream';
import {
  computeValidatorMetrics,
  computeTotalActiveStake,
  isInActiveSet,
  computeValidatorScore,
  computeAuthStake,
} from '@/lib/validatorMetrics';

export const dynamic = 'force-dynamic';

const CACHE_TTL = 60_000;
const cache = new Map<string, { ts: number; data: unknown }>();

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const addr = address.toLowerCase();

  // Network resolution: prefer ?network=, fall back to testnet.
  const rawNet = req.nextUrl.searchParams.get('network') ?? 'testnet';
  const network: NetworkId = (rawNet === 'mainnet' ? 'mainnet' : 'testnet');

  const cacheKey = `${network}:${addr}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  const RECENT_SHOW = 20;

  try {
    // Same RPC routing as list-API: testnet via our local validator,
    // mainnet via the public RPC from NETWORKS.mainnet.rpc.
    const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
      ? process.env.MONAD_RPC_URL
      : NETWORKS[network].rpc;
    await ensureRegistryLoaded(rpcUrl, network);

    let blocks = getBlockCache(network) as {
      miner: string; number: string; timestamp: string;
      transactions: unknown[]; hash: string;
    }[] | null;

    if (!blocks) {
      const fetched = await getLatestBlocksBatched(network, 500, false, 20, 200);
      setBlockCache(network, fetched as Parameters<typeof setBlockCache>[1]);
      blocks = fetched as NonNullable<typeof blocks>;
    }

    blocks = blocks!;

    const validBlocks = blocks.filter(b => b?.miner);
    const totalBlocks = validBlocks.length;

    // All miners stats for context
    const minerCounts = new Map<string, number>();
    for (const b of validBlocks) {
      const m = b.miner.toLowerCase();
      minerCounts.set(m, (minerCounts.get(m) ?? 0) + 1);
    }
    // `producersInWindow` = unique miner addresses observed in the block
    // sample. Earlier this was named `numValidators` which was misleading:
    // it's NOT the active set size (that's ~197) and NOT the registered
    // count (~267) — it's just the distinct producers seen in the last 500
    // blocks. Renamed to make the semantic explicit.
    const producersInWindow = minerCounts.size;

    // Match list-API attribution exactly: an authAddress owns ALL validator
    // IDs registered to it (operators like Category Labs run 4+ IDs under one
    // auth — without this rollup, DETAIL would only count one ID's blocks
    // while LIST sums across all IDs, producing systematic divergence).
    //
    // CRUCIAL: source ownedValidatorIds from per-ID chainData, NOT auth-deduped
    // registry. The moniker registry only stores ONE entry per authAddress,
    // so reading from it would silently drop 3 of Category Labs' 4 IDs.
    //
    // Fall back to block.miner equality when the rewards event hasn't been
    // observed yet — same logic as list-API. This catches validators with
    // non-authAddress beneficiaries (separate rewards wallets, 0x0).
    const _info = getValidatorInfo(addr, network);
    const _chainDataForAttribution = getChainDataById(network);
    const ownedValidatorIds = new Set<number>();
    for (const [id, data] of _chainDataForAttribution) {
      if (data.authAddress.toLowerCase() === addr) ownedValidatorIds.add(id);
    }
    const myBlocks = validBlocks.filter(b => {
      const bn = parseInt(b.number, 16);
      const vid = getValidatorIdForBlock(bn);
      if (vid !== null) {
        return ownedValidatorIds.has(vid);
      }
      return b.miner.toLowerCase() === addr;
    });
    const blocksProduced = myBlocks.length;

    // Time window
    const timestamps = validBlocks.map(b => parseInt(b.timestamp, 16));
    const newestTs = Math.max(...timestamps);
    const oldestTs = Math.min(...timestamps);
    const windowSeconds = Math.max(1, newestTs - oldestTs);

    // My stats
    const myTimestamps = myBlocks.map(b => parseInt(b.timestamp, 16));
    const lastBlockTs = myTimestamps.length ? Math.max(...myTimestamps) : 0;
    const firstBlockTs = myTimestamps.length ? Math.min(...myTimestamps) : 0;
    const totalTxs = myBlocks.reduce((s, b) => s + (Array.isArray(b.transactions) ? b.transactions.length : 0), 0);

    const info = _info;
    const consensusIds = getConsensusIds(network);
    const chainData = _chainDataForAttribution;
    // Auth-rolled-up stake — sums across every ID this auth owns. Mirrors
    // list-API behaviour. See computeAuthStake JSDoc for full rationale.
    const auth = computeAuthStake(addr, chainData, consensusIds);
    const stakeMon = auth.validatorIds.length > 0 ? auth.stakeMon : (info?.stakeMon ?? null);
    const isActiveSet = auth.activeIds.length > 0
      ? true
      : isInActiveSet(info?.validatorId, stakeMon, consensusIds);
    const totalActiveStake = computeTotalActiveStake(chainData, consensusIds);

    // Long-window aggregator data — same source as list-API. Detail used to
    // omit participationLong; now provides parity so external integrators
    // can rely on a single shape.
    const aggregateState = getAggregateState();
    const aggForMe = getMinerAggregate().find(a => a.miner === addr);

    // Single source of truth — see lib/validatorMetrics.ts. Both list and
    // detail call this exact helper with identical inputs, so participationPct
    // can no longer drift between the two endpoints.
    const m = computeValidatorMetrics({
      blocksProduced,
      firstBlockTs,
      lastBlockTs,
      newestTs,
      oldestTs,
      windowSeconds,
      totalBlocks,
      producersInWindow,
      stakeMon,
      isActiveSet,
      totalActiveStake,
      cumulativeBlocksObserved: aggregateState.totalBlocks,
      cumulativeMinerBlocks: aggForMe?.blocks ?? 0,
    });

    const score = computeValidatorScore({
      health: m.health,
      participationPct: m.participationPct,
      ageSeconds: m.ageSeconds,
      personalGapSeconds: m.personalGapSeconds,
      registered: info != null,
    });

    // Recent blocks for this validator
    const recentBlocks = myBlocks
      .sort((a, b) => parseInt(b.number, 16) - parseInt(a.number, 16))
      .slice(0, RECENT_SHOW)
      .map(b => ({
        number: parseInt(b.number, 16),
        timestamp: parseInt(b.timestamp, 16),
        txCount: Array.isArray(b.transactions) ? b.transactions.length : 0,
        hash: b.hash,
      }));

    const data = {
      address: addr,
      moniker: info?.moniker ?? null,
      info,
      stakeMon,
      validatorIds: auth.validatorIds,
      activeValidatorIdsCount: auth.activeIds.length,
      commissionPct: info?.commissionPct ?? null,
      registered: info != null,
      isActiveSet,
      beneficiary: info?.validatorId ? getBeneficiaryForValidator(info.validatorId) : null,
      consensusSetSize: consensusIds.size,
      stats: {
        health: m.health,
        score,
        blocksProduced,
        totalTxs,
        sharePct: m.sharePct,
        participationPct: m.participationPct,
        participationLong: m.participationLong,        // parity with list-API
        ageSeconds: m.ageSeconds,
        lastBlockTs,
        firstBlockTs,
        isNewInWindow: m.isNewInWindow,
        activeWindowSeconds: Math.round(m.activeWindowSeconds),
      },
      context: {
        sampleSize: totalBlocks,
        producersInWindow,
        expectedGapSeconds: round1(m.expectedGapSeconds),
        personalGapSeconds: round1(m.personalGapSeconds),
        windowSeconds,
      },
      recentBlocks,
      fetchedAt: Date.now(),
    };

    cache.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err), address: addr }, { status: 500 });
  }
}
