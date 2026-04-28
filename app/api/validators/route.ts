import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getMoniker, getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getRegistryEntries } from '@/lib/validator-registry';
import { setBlockCache } from '@/lib/block-cache';
import { getMinerAggregate, getAggregateState } from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

// 1000 blocks @ ~0.4s block time ≈ 6-7 minutes of history. Previously 5000,
// reduced 2026-04-25 because the 5000-block fetch (10 batches × 500 methods
// in one JSON-RPC POST) caused periodic ~500-2500 WARN/min storms on
// monad-rpc — each batch overflowed the validator's `triedb_env` channel
// before it could drain. 1000 blocks still covers enough leader rotations
// (200 active validators × ~0.4s = 80s per full rotation → 5+ rotations).
// See: wiki ops/incidents/validators-bulk-fetch-burst-2026-04-25.md
// FRESH_TTL 15min: validator stake/commission/registry don't change every 5min.
// On testnet specifically, the only meaningful change is block-production
// activity which the sample window refreshes anyway.
// Was 5min — refresh storms every 6min were caused by tickValidatorSetTracker
// (60s tick) repeatedly hitting the cache miss boundary.
const FRESH_TTL_MS = 15 * 60_000;
const STALE_TTL_MS = 30 * 60_000;  // then serve stale while revalidating in background
// SAMPLE_BLOCKS 500: 500 blocks ≈ 200s of history at 0.4s block time, still
// covers 5+ leader rotations (validator set ~200 active = ~80s/rotation).
// Was 1000 — combined with batch=50 it overflowed monad-rpc triedb_env
// channel. Halving sample × halving batch (50→25) brings each batch under
// the channel size limit while keeping refresh time at ~4-5s.
const SAMPLE_BLOCKS = 500;

interface CacheEntry {
  ts: number;
  data: unknown;
}
const cache = new Map<NetworkId, CacheEntry>();
const refreshing = new Map<NetworkId, boolean>();

async function computeValidators(network: NetworkId) {
  const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS[network].rpc;
  await ensureRegistryLoaded(rpcUrl);

  // batch=20 + pauseMs=200ms — restored 2026-04-27 16:40 UTC after measurement
  // showed batch=25 in combination with concurrent pollers caused conn pool to
  // double (3→6) and produced a 41-min continuous burst series. The known-good
  // state at 15:23 UTC ("правка 3") had 0 WARN/30min with batch=20 and 3 conns.
  // Lesson: changes interact in non-obvious ways under load — revert rather
  // than try-and-measure when in doubt.
  const blocks = await getLatestBlocksBatched(network, SAMPLE_BLOCKS, false, 20, 200);
  setBlockCache(network, blocks as Parameters<typeof setBlockCache>[1]);

  const stats = new Map<string, {
    address: string;
    blocksProduced: number;
    totalTxs: number;
    lastBlockNumber: number;
    lastBlockTs: number;
    firstBlockNumber: number;   // earliest block by this validator in the sample
    firstBlockTs: number;
  }>();

  for (const block of blocks as {
    miner: string;
    number: string;
    timestamp: string;
    transactions?: unknown[];
  }[]) {
    if (!block?.miner) continue;
    const addr = block.miner.toLowerCase();
    if (addr === '0x0000000000000000000000000000000000000000') continue;
    const entry = stats.get(addr) ?? {
      address: addr,
      blocksProduced: 0,
      totalTxs: 0,
      lastBlockNumber: 0,
      lastBlockTs: 0,
      firstBlockNumber: 0,
      firstBlockTs: 0,
    };
    entry.blocksProduced++;
    entry.totalTxs += Array.isArray(block.transactions) ? block.transactions.length : 0;
    const blockNum = parseInt(block.number, 16);
    const blockTs = parseInt(block.timestamp, 16);
    if (blockNum > entry.lastBlockNumber) {
      entry.lastBlockNumber = blockNum;
      entry.lastBlockTs = blockTs;
    }
    if (entry.firstBlockNumber === 0 || blockNum < entry.firstBlockNumber) {
      entry.firstBlockNumber = blockNum;
      entry.firstBlockTs = blockTs;
    }
    stats.set(addr, entry);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const newestTs = (blocks as { timestamp: string }[])
    .reduce((m, b) => Math.max(m, parseInt(b.timestamp, 16)), 0);
  const oldestTs = (blocks as { timestamp: string }[])
    .reduce((m, b) => (m === 0 ? parseInt(b.timestamp, 16) : Math.min(m, parseInt(b.timestamp, 16))), 0);
  const windowSeconds = Math.max(1, newestTs - oldestTs);

  const numValidators = stats.size;
  // expectedGap is still based on producer count — this is for "is this miner
  // late?" timing logic, not for stake-weighted fairness.
  const expectedGap = numValidators > 0 ? (windowSeconds / blocks.length) * numValidators : 60;

  // Threshold for detecting "new" validators: if their first block in the
  // sample is more than 2 expected gaps after the window start, they likely
  // weren't active for the whole window.
  const NEW_DETECT_THRESHOLD = expectedGap * 2;

  // Seed stats map with every on-chain validator from the registry, so that
  // validators who haven't produced blocks in the sample window still appear
  // (with zero blocks → health=missing). Without this we only see miners.
  for (const info of getRegistryEntries()) {
    const addr = info.authAddress.toLowerCase();
    if (!addr || addr === '0x0000000000000000000000000000000000000000') continue;
    if (!stats.has(addr)) {
      stats.set(addr, {
        address: addr,
        blocksProduced: 0,
        totalTxs: 0,
        lastBlockNumber: 0,
        lastBlockTs: 0,
        firstBlockNumber: 0,
        firstBlockTs: 0,
      });
    }
  }

  // Compute active-set total stake for stake-weighted participation.
  // Active set on Monad = validators with snapshotStake >= 10M MON. The leader
  // election is stake-weighted, so a validator's expected blocks-produced is
  // `blocks.length × (its stake / total active stake)`, NOT `blocks.length / N`.
  // Without this normalization, top-stake validators appear at 700%+ "participation"
  // when they are simply earning their fair stake-weighted share.
  const ACTIVE_STAKE_MIN = 10_000_000;
  let totalActiveStake = 0;
  for (const info of getRegistryEntries()) {
    if ((info.stakeMon ?? 0) >= ACTIVE_STAKE_MIN) {
      totalActiveStake += info.stakeMon ?? 0;
    }
  }

  // Cumulative aggregate from the WebSocket stream (since process start).
  // Indexed by lowercase miner address. After 30+ minutes of runtime this
  // gives a much larger sample (thousands of blocks) than the 500-block
  // window above, so participation calculations are statistically stable
  // (variance ~1σ on hours of data vs ~5σ on 500 blocks).
  const aggregateMap = new Map<string, ReturnType<typeof getMinerAggregate>[number]>();
  for (const a of getMinerAggregate()) aggregateMap.set(a.miner, a);
  const aggregateState = getAggregateState();

  const validators = Array.from(stats.values())
    .map(v => {
      // `ageSeconds` = how stale is this validator's last block _relative to
      // the newest block in our sample_ (NOT wall-clock now). This is the
      // right reference because /api/validators background refresh can take
      // 30-60 seconds — using wall-clock `nowSec` would penalise every
      // validator by that refresh-duration delta even though block production
      // was healthy at sample time. Consumers still see "live enough" if
      // this number stays under expectedGap × 2.
      const ageSeconds = v.lastBlockTs > 0
        ? Math.max(0, newestTs - v.lastBlockTs)
        : Math.max(0, nowSec - oldestTs);  // registry-only entries → window-span

      // Active-window adjustment: validators that joined mid-window are
      // not penalised for not existing in earlier blocks.
      const isNewInWindow = v.firstBlockTs > oldestTs + NEW_DETECT_THRESHOLD;
      const activeWindowStart = isNewInWindow ? v.firstBlockTs : oldestTs;
      const activeWindowSec = Math.max(
        expectedGap * 3,
        newestTs - activeWindowStart + expectedGap,
      );
      const activeRatio = windowSeconds > 0 ? activeWindowSec / windowSeconds : 1;

      let health: 'active' | 'slow' | 'missing';
      if (ageSeconds < expectedGap * 2) health = 'active';
      else if (ageSeconds < expectedGap * 5) health = 'slow';
      else health = 'missing';

      const info = getValidatorInfo(v.address);
      const stakeMon = info?.stakeMon ?? null;
      const isActiveSet = (stakeMon ?? 0) >= ACTIVE_STAKE_MIN;

      // Two participation values:
      //   participationPct       — short-window (sample blocks). High variance
      //                            on 500 blocks but reflects current behavior.
      //   participationLong      — cumulative aggregate from WS stream since
      //                            process start. Stable on hours of runtime.
      // Both null when stake unknown or not in active set — leader election
      // is stake-weighted within the active set; outside it the metric is
      // meaningless.
      let participationPct: number | null = null;
      let participationLong: number | null = null;
      if (isActiveSet && totalActiveStake > 0) {
        const stakeShare = (stakeMon ?? 0) / totalActiveStake;
        const expectedShort = blocks.length * stakeShare * Math.min(activeRatio, 1);
        if (expectedShort > 0) {
          participationPct = Math.round((v.blocksProduced / expectedShort) * 1000) / 10;
        }
        // Long-window: based on cumulative WS aggregate. Need at least
        // ~5 expected blocks for the metric to be meaningful (otherwise
        // null — the aggregator is too young).
        const longBlocksObserved = aggregateState.totalBlocks;
        const expectedLong = longBlocksObserved * stakeShare;
        if (expectedLong >= 5) {
          const agg = aggregateMap.get(v.address);
          const observedLong = agg?.blocks ?? 0;
          participationLong = Math.round((observedLong / expectedLong) * 1000) / 10;
        }
      }

      const agg = aggregateMap.get(v.address);

      return {
        ...v,
        moniker: info?.moniker ?? null,
        stakeMon,
        commissionPct: info?.commissionPct ?? null,
        // `registered` = the miner address matches an on-chain authAddress
        // in the staking precompile. Non-matched block producers are active
        // operators with separate signing keys; their stake is real but we
        // can't resolve it without a miner→validator-id lookup.
        registered: info != null,
        isActiveSet,
        sharePct: Math.round((v.blocksProduced / blocks.length) * 1000) / 10,
        ageSeconds,
        participationPct,        // short window (high variance)
        participationLong,       // cumulative since process start (stable)
        // Cumulative blocks/txs since aggregator started (process boot).
        // Useful for "long-running performance" view of a validator.
        cumulativeBlocks: agg?.blocks ?? 0,
        cumulativeTxs: agg?.txs ?? 0,
        health,
        isNewInWindow,
        activeWindowSeconds: Math.round(activeWindowSec),
      };
    })
    .sort((a, b) => b.blocksProduced - a.blocksProduced);

  // Counts:
  //   activeValidators   — those in active set (snapshotStake >= 10M MON).
  //                        This is what to show on the hero/header — matches
  //                        Monad's documented active set size (~200).
  //   producersInWindow  — validators that produced at least one block in
  //                        the sample. Always <= activeValidators (most active
  //                        validators produce in 200s of blocks).
  //   registeredCount    — total entries in the staking precompile (registry).
  //                        Includes pending/inactive registered validators.
  //   totalKnown         — union of producers + registered (current legacy
  //                        `totalValidators`). Kept for backwards-compat.
  const producersInWindow = validators.filter(v => v.blocksProduced > 0).length;
  const activeValidators = validators.filter(v => v.isActiveSet).length;
  const registeredCount = getRegistryEntries().length;

  return {
    network,
    sampleSize: blocks.length,
    activeValidators,
    producersInWindow,
    registeredCount,
    totalValidators: validators.length,             // legacy / backwards-compat
    totalKnown: validators.length,                  // explicit name
    totalActiveStakeMon: Math.round(totalActiveStake),
    windowSeconds,
    expectedGapSeconds: Math.round(expectedGap * 10) / 10,
    // Cumulative stream stats — supports the long-window participation values
    // on each validator (participationLong + cumulativeBlocks).
    aggregate: {
      windowSec: Math.round(aggregateState.windowMs / 1000),
      totalBlocksObserved: aggregateState.totalBlocks,
      totalTxsObserved: aggregateState.totalTxs,
      uniqueMiners: aggregateState.uniqueMiners,
      firstBlock: aggregateState.firstBlock,
    },
    updatedAt: Date.now(),
    validators,
  };
}

function refreshInBackground(network: NetworkId) {
  if (refreshing.get(network)) return;
  refreshing.set(network, true);
  computeValidators(network)
    .then(data => { cache.set(network, { ts: Date.now(), data }); })
    .catch(err => { console.error('[validators] background refresh failed:', err); })
    .finally(() => { refreshing.set(network, false); });
}

// Warm up cache on server start
refreshInBackground('testnet');

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;

  const cached = cache.get(network);
  const age = cached ? Date.now() - cached.ts : Infinity;

  if (cached && age < FRESH_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  // Kick off a refresh in background regardless; serve whatever we have.
  refreshInBackground(network);

  if (cached) {
    // Serve stale copy while refresh runs.
    return NextResponse.json({
      ...(cached.data as object),
      stale: age >= FRESH_TTL_MS,
      ageSeconds: Math.floor(age / 1000),
    });
  }

  // No cache at all — tell client we're building. Client retries on interval.
  return NextResponse.json({
    network,
    building: true,
    message: 'Collecting validator sample (5000 blocks, ~2-3 min on cold start)…',
    validators: [],
    totalValidators: 0,
    sampleSize: 0,
    windowSeconds: 0,
    expectedGapSeconds: 0,
    updatedAt: Date.now(),
  }, { status: 202 });
}
