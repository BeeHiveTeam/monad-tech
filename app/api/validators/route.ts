import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getMoniker, getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getRegistryEntries, getConsensusIds } from '@/lib/validator-registry';
import { setBlockCache } from '@/lib/block-cache';
import { getMinerAggregate, getAggregateState } from '@/lib/wsBlockStream';
import { getValidatorIdForBlock, recordBeneficiary, getBeneficiaryForValidator } from '@/lib/beneficiaryMap';

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
  // Testnet uses our own validator (faster + higher limits) when MONAD_RPC_URL
  // is set; mainnet always goes through the public RPC configured in
  // NETWORKS.mainnet.rpc until we run our own mainnet node.
  const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
    ? process.env.MONAD_RPC_URL
    : NETWORKS[network].rpc;
  await ensureRegistryLoaded(rpcUrl, network);

  // batch=20 + pauseMs=200ms — restored 2026-04-27 16:40 UTC after measurement
  // showed batch=25 in combination with concurrent pollers caused conn pool to
  // double (3→6) and produced a 41-min continuous burst series. The known-good
  // state at 15:23 UTC (revision 3) had 0 WARN/30min with batch=20 and 3 conns.
  // Lesson: changes interact in non-obvious ways under load — revert rather
  // than try-and-measure when in doubt.
  const blocks = await getLatestBlocksBatched(network, SAMPLE_BLOCKS, false, 20, 200);
  setBlockCache(network, blocks as Parameters<typeof setBlockCache>[1]);

  // Build a quick lookup from validatorId → authAddress so we can attribute
  // blocks to their producer regardless of beneficiary config.
  const idToAuth = new Map<number, string>();
  for (const e of getRegistryEntries(network)) {
    if (e.id) idToAuth.set(e.id, e.authAddress.toLowerCase());
  }

  const stats = new Map<string, {
    address: string;
    blocksProduced: number;
    totalTxs: number;
    lastBlockNumber: number;
    lastBlockTs: number;
    firstBlockNumber: number;   // earliest block by this validator in the sample
    firstBlockTs: number;
  }>();

  // Attribution: for each block in the sample, look up its producer via the
  // ValidatorRewarded event scanner (lib/beneficiaryMap.ts). This works even
  // when the operator's beneficiary != authAddress (rewards wallet) or = 0x0
  // (e.g. shadowoftime). Falls back to block.miner only when the rewards
  // event hasn't been observed yet (cold-start window or scanner lagging).
  for (const block of blocks as {
    miner: string;
    number: string;
    timestamp: string;
    transactions?: unknown[];
  }[]) {
    if (!block?.miner) continue;
    const blockNum = parseInt(block.number, 16);
    const blockTs = parseInt(block.timestamp, 16);

    // Resolve producer authAddress via reward event → validatorId → registry.
    let attributionAddr: string | null = null;
    const validatorId = getValidatorIdForBlock(blockNum);
    if (validatorId !== null) {
      const auth = idToAuth.get(validatorId);
      if (auth) attributionAddr = auth;
      // Record the beneficiary observation for diagnostic exposure.
      if (block.miner) recordBeneficiary(validatorId, block.miner);
    }
    if (!attributionAddr) {
      const m = block.miner.toLowerCase();
      if (m === '0x0000000000000000000000000000000000000000') continue;
      attributionAddr = m;
    }

    const entry = stats.get(attributionAddr) ?? {
      address: attributionAddr,
      blocksProduced: 0,
      totalTxs: 0,
      lastBlockNumber: 0,
      lastBlockTs: 0,
      firstBlockNumber: 0,
      firstBlockTs: 0,
    };
    entry.blocksProduced++;
    entry.totalTxs += Array.isArray(block.transactions) ? block.transactions.length : 0;
    if (blockNum > entry.lastBlockNumber) {
      entry.lastBlockNumber = blockNum;
      entry.lastBlockTs = blockTs;
    }
    if (entry.firstBlockNumber === 0 || blockNum < entry.firstBlockNumber) {
      entry.firstBlockNumber = blockNum;
      entry.firstBlockTs = blockTs;
    }
    stats.set(attributionAddr, entry);
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
  for (const info of getRegistryEntries(network)) {
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
  // Active set on Monad = TOP-200 staked validators per epoch via
  // syscallSnapshot, with minimums of 100k MON self + 10M MON total. We use
  // getConsensusValidatorSet() as the canonical source. The earlier
  // approximation `stakeMon >= 10M` was wrong by a few validators (didn't
  // account for the top-200 cap, edge cases with snapshot stake just under
  // 10M but seated by protocol). See [[validator-scoring-semantics]].
  // Stake-weighted: a validator's expected blocks-produced is
  // `blocks.length × (its stake / total active stake)`, NOT `blocks.length / N`.
  const ACTIVE_STAKE_MIN = 10_000_000;  // protocol minimum, fallback only
  const consensusIds = getConsensusIds(network);
  const useCanonicalSet = consensusIds.size > 0;
  let totalActiveStake = 0;
  for (const info of getRegistryEntries(network)) {
    const inSet = useCanonicalSet
      ? consensusIds.has(info.id)
      : (info.stakeMon ?? 0) >= ACTIVE_STAKE_MIN;
    if (inSet) totalActiveStake += info.stakeMon ?? 0;
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

      const info = getValidatorInfo(v.address, network);
      const stakeMon = info?.stakeMon ?? null;
      // Canonical active-set check: validator ID is in the result of
      // getConsensusValidatorSet(). Falls back to the stake threshold only
      // during cold-start when the precompile call hasn't completed yet.
      const isActiveSet = useCanonicalSet
        ? (info?.validatorId != null && consensusIds.has(info.validatorId))
        : (stakeMon ?? 0) >= ACTIVE_STAKE_MIN;

      // Stake-weighted personal expected gap. Leader election is stake-weighted
      // within the active set, so a validator with 0.5% stake share produces
      // ~0.5% of blocks. Their typical inter-block gap is therefore
      // windowSeconds / (blocks.length × stakeShare), NOT the global mean.
      // Using the global mean for thresholds caused low-stake validators to
      // chronically appear `slow` even when producing exactly their fair share.
      // For non-active-set validators or unknown stake, we keep the global
      // gap — they shouldn't be in the active rotation anyway.
      const stakeShareForGap = (isActiveSet && stakeMon != null && totalActiveStake > 0)
        ? stakeMon / totalActiveStake
        : 0;
      const personalGap = stakeShareForGap > 0 && blocks.length > 0
        ? windowSeconds / (blocks.length * stakeShareForGap)
        : expectedGap;

      let health: 'active' | 'slow' | 'missing';
      if (v.blocksProduced === 0) {
        // Zero blocks observed in the sample window. Without this branch the
        // age-based classification falls back to `nowSec - oldestTs`, which
        // is bounded by window-span (~3× expectedGap with sampleSize=500),
        // never the 5× MISSING threshold — so every zero-block validator
        // gets labeled 'slow', misleading delegators. Force 'missing' here
        // regardless of active-set status; the score (healthScore=0,
        // uptimeScore=0) is the honest signal.
        health = 'missing';
      } else if (ageSeconds < personalGap * 2) health = 'active';
      else if (ageSeconds < personalGap * 5) health = 'slow';
      else health = 'missing';

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
      const benef = info?.validatorId ? getBeneficiaryForValidator(info.validatorId) : null;

      return {
        ...v,
        moniker: info?.moniker ?? null,
        stakeMon,
        commissionPct: info?.commissionPct ?? null,
        // `registered` — entry exists in the on-chain staking precompile
        // registry (matched via authAddress lookup, possibly via the
        // beneficiaryMap if block.miner != authAddress).
        registered: info != null,
        isActiveSet,
        // Beneficiary = block.miner address as set by operator in node.toml.
        // Equal to authAddress for most validators, separate wallet for some,
        // 0x0 for those who left it unconfigured.
        beneficiary: benef,
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
  //   activeValidators        — protocol-level ACTIVE_VALSET_SIZE = consensusIds.size
  //                             (= 200 on testnet). This matches Monad's documented
  //                             active set and what other dashboards show.
  //   activeOperators         — distinct authAddresses in the active set. Lower
  //                             than activeValidators when an operator runs
  //                             multiple validator IDs sharing one authAddress
  //                             (e.g. Category Labs has 4 IDs at 25M MON each
  //                             under address 0xfa0345...). Use this when the
  //                             question is "how many independent operators".
  //   producersInWindow       — validators that produced at least one block in
  //                             the sample. Always <= activeOperators (rows in
  //                             the table) since the table dedups by address.
  //   registeredCount         — total entries in the staking precompile registry.
  //                             Includes pending/inactive registered validators.
  //   totalKnown              — union of producers + registered (current legacy
  //                             `totalValidators`). Kept for backwards-compat.
  const producersInWindow = validators.filter(v => v.blocksProduced > 0).length;
  const activeOperators = validators.filter(v => v.isActiveSet).length;
  const activeValidators = useCanonicalSet ? consensusIds.size : activeOperators;
  const registeredCount = getRegistryEntries(network).length;

  return {
    network,
    sampleSize: blocks.length,
    activeValidators,
    activeOperators,                                // distinct authAddresses (≤ activeValidators)
    consensusSetSize: consensusIds.size,            // canonical (0 = falling back to stake threshold)
    activeSetSource: useCanonicalSet ? 'consensus-precompile' : 'stake-threshold-fallback',
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
