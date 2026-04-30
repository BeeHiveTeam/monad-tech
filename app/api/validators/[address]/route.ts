import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getRegistryEntries, getConsensusIds } from '@/lib/validator-registry';
import { NETWORKS } from '@/lib/networks';
import { getBlockCache, setBlockCache } from '@/lib/block-cache';

export const dynamic = 'force-dynamic';

const CACHE_TTL = 60_000;
const cache = new Map<string, { ts: number; data: unknown }>();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const addr = address.toLowerCase();

  const cached = cache.get(addr);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  const RECENT_SHOW = 20;

  try {
    const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS['testnet'].rpc;
    await ensureRegistryLoaded(rpcUrl);

    // Use shared block cache from validators API if fresh, otherwise fetch own sample
    let blocks = getBlockCache('testnet') as {
      miner: string; number: string; timestamp: string;
      transactions: unknown[]; hash: string;
    }[] | null;

    if (!blocks) {
      // Match list-API SAMPLE_BLOCKS=500 so sharePct/blocksProduced/etc. are
      // computed on the same window — otherwise list shows "21 blocks" and
      // detail shows "76 blocks" for the same validator depending on which
      // endpoint was hit first (cache empty vs warm).
      const fetched = await getLatestBlocksBatched('testnet', 500, false, 20, 200);
      setBlockCache('testnet', fetched as Parameters<typeof setBlockCache>[1]);
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
    const expectedBlocks = producersInWindow > 0 ? totalBlocks / producersInWindow : 1;

    const myBlocks = validBlocks.filter(b => b.miner.toLowerCase() === addr);
    const blocksProduced = myBlocks.length;

    // Time window
    const timestamps = validBlocks.map(b => parseInt(b.timestamp, 16));
    const newestTs = Math.max(...timestamps);
    const oldestTs = Math.min(...timestamps);
    const windowSeconds = Math.max(1, newestTs - oldestTs);
    const expectedGapSeconds = producersInWindow > 0 ? (windowSeconds / totalBlocks) * producersInWindow : 60;

    // My stats
    const myTimestamps = myBlocks.map(b => parseInt(b.timestamp, 16));
    const lastBlockTs = myTimestamps.length ? Math.max(...myTimestamps) : 0;
    const firstBlockTs = myTimestamps.length ? Math.min(...myTimestamps) : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    // Match list-API fallback semantics. When the validator produced no blocks
    // in the sample window, fall back to "window-span age" instead of a 999999
    // sentinel — list-API does the same. Without this the detail page reports
    // health=unknown and score=0 while the table reports health=slow and
    // score=~24 for the exact same validator (e.g. validators using a separate
    // signing key whose blocks don't match their authAddress).
    const ageSeconds = lastBlockTs > 0
      ? Math.max(0, newestTs - lastBlockTs)
      : Math.max(0, nowSec - oldestTs);
    const totalTxs = myBlocks.reduce((s, b) => s + (Array.isArray(b.transactions) ? b.transactions.length : 0), 0);
    const sharePct = totalBlocks > 0 ? Math.round((blocksProduced / totalBlocks) * 1000) / 10 : 0;
    // Uptime relative to validator's active window — a new validator that
    // appeared mid-sample isn't penalised for blocks it couldn't have produced.
    const isNewInWindow = firstBlockTs > 0 && firstBlockTs > oldestTs + expectedGapSeconds * 2;
    const activeWindowStart = isNewInWindow ? firstBlockTs : oldestTs;
    const activeWindowSec = Math.max(
      expectedGapSeconds * 3,
      newestTs - activeWindowStart + expectedGapSeconds,
    );
    const activeRatio = windowSeconds > 0 ? Math.min(activeWindowSec / windowSeconds, 1) : 1;
    const adjustedExpected = expectedBlocks * activeRatio;
    const participationPct = adjustedExpected > 0
      ? Math.round((blocksProduced / adjustedExpected) * 1000) / 10
      : 0;

    const info = getValidatorInfo(addr);
    const stakeMon = info?.stakeMon ?? null;
    const consensusIds = getConsensusIds();
    const useCanonicalSet = consensusIds.size > 0;
    const isActiveSet = useCanonicalSet
      ? (info?.validatorId != null && consensusIds.has(info.validatorId))
      : (stakeMon ?? 0) >= 10_000_000;

    // Stake-weighted personal expected gap — mirrors list-API logic.
    // For active-set validators with known stake, expected inter-block gap is
    // windowSeconds / (blocks.length × stakeShare). Falls back to global mean
    // for non-active-set / unknown stake.
    let totalActiveStake = 0;
    for (const e of getRegistryEntries()) {
      const inSet = useCanonicalSet
        ? consensusIds.has(e.id)
        : (e.stakeMon ?? 0) >= 10_000_000;
      if (inSet) totalActiveStake += e.stakeMon ?? 0;
    }
    const stakeShareForGap = (isActiveSet && stakeMon != null && totalActiveStake > 0)
      ? stakeMon / totalActiveStake
      : 0;
    const personalGap = stakeShareForGap > 0 && totalBlocks > 0
      ? windowSeconds / (totalBlocks * stakeShareForGap)
      : expectedGapSeconds;

    // Health classification mirrors list-API thresholds (active/slow/missing).
    // Zero-block validators are forced to 'missing' because ageSeconds
    // clamps at window-span — see list-API for the full rationale.
    let health: 'active' | 'slow' | 'missing' | 'unknown';
    if (blocksProduced === 0) health = 'missing';
    else if (ageSeconds < personalGap * 2) health = 'active';
    else if (ageSeconds < personalGap * 5) health = 'slow';
    else health = 'missing';

    // Score
    const healthScore = health === 'active' ? 100 : health === 'slow' ? 40 : 0;
    const uptimeScore = Math.min(participationPct, 100);
    const maxAge = personalGap * 5;
    const recencyScore = maxAge > 0 ? Math.max(0, (1 - ageSeconds / maxAge)) * 100 : 0;
    const score = Math.round(healthScore * 0.4 + uptimeScore * 0.4 + recencyScore * 0.2);

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
      commissionPct: info?.commissionPct ?? null,
      registered: info != null,
      isActiveSet,
      consensusSetSize: consensusIds.size,
      stats: {
        health,
        score,
        blocksProduced,
        totalTxs,
        sharePct,
        participationPct,
        ageSeconds,
        lastBlockTs,
        firstBlockTs,
        isNewInWindow,
        activeWindowSeconds: Math.round(activeWindowSec),
      },
      context: {
        sampleSize: totalBlocks,
        producersInWindow,
        expectedGapSeconds,
        personalGapSeconds: Math.round(personalGap * 10) / 10,
        windowSeconds,
      },
      recentBlocks,
      fetchedAt: Date.now(),
    };

    cache.set(addr, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err), address: addr }, { status: 500 });
  }
}
