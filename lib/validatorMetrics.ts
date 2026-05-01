/**
 * Single source of truth for per-validator metrics shared between
 * /api/validators (list) and /api/validators/[address] (detail).
 *
 * Prior bug: each route inlined its own formula for participationPct.
 * LIST used a stake-weighted denominator, DETAIL used uniform
 * (totalBlocks/producersInWindow). Same field name, different numbers,
 * drifted further with each release. This helper enforces the invariant
 * by construction — both routes call computeValidatorMetrics() with the
 * inputs they already have.
 *
 * Stake-weighted is the correct semantic: Monad leader election is
 * stake-weighted within the active set, so a validator's expected
 * blocks-produced is `windowBlocks × (stakeMon / totalActiveStake)`,
 * NOT `windowBlocks / producerCount`.
 */

export type ValidatorHealth = 'active' | 'slow' | 'missing';

export interface ValidatorMetricsInput {
  blocksProduced: number;
  firstBlockTs: number;       // 0 if validator produced no blocks in sample
  lastBlockTs: number;        // 0 if validator produced no blocks in sample
  newestTs: number;           // newest block ts in the sample
  oldestTs: number;           // oldest block ts in the sample
  windowSeconds: number;      // max(1, newestTs - oldestTs)
  totalBlocks: number;        // sample size (e.g. 500)
  producersInWindow: number;  // distinct miners observed in the sample
  stakeMon: number | null;
  isActiveSet: boolean;
  totalActiveStake: number;
  // Long-window (cumulative WS aggregator since process start). Pass 0/0 if
  // the caller doesn't have aggregator data — participationLong will be null.
  cumulativeBlocksObserved: number;  // aggregateState.totalBlocks
  cumulativeMinerBlocks: number;     // agg.blocks for this validator
}

export interface ValidatorMetricsOutput {
  ageSeconds: number;
  isNewInWindow: boolean;
  activeWindowSeconds: number;
  activeRatio: number;                 // ≤ 1
  expectedGapSeconds: number;          // global mean (uniform)
  personalGapSeconds: number;          // stake-weighted; falls back to global
  expectedBlocks: number;              // stake-weighted expected for this validator (raw)
  participationPct: number | null;     // 100 × (observed / expected), null when not in active set
  participationLong: number | null;    // cumulative-window equivalent, null when sample too small
  health: ValidatorHealth;
  sharePct: number;                    // observed / totalBlocks × 100
}

/**
 * Compute every per-validator metric in one place. All formulas mirror what
 * /api/validators previously had inline; the detail route now matches by
 * construction.
 *
 * Health classification:
 *   - blocksProduced === 0 → 'missing' (regardless of age — the age fallback
 *     of `nowSec - oldestTs` is bounded by window-span and never crosses the
 *     5× MISSING threshold, which would mislabel zero-block validators as
 *     'slow' delegates).
 *   - else compare ageSeconds to `personalGap` (stake-weighted): <2× = active,
 *     <5× = slow, otherwise missing.
 */
export function computeValidatorMetrics(input: ValidatorMetricsInput): ValidatorMetricsOutput {
  const {
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
    cumulativeBlocksObserved,
    cumulativeMinerBlocks,
  } = input;

  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = lastBlockTs > 0
    ? Math.max(0, newestTs - lastBlockTs)
    : Math.max(0, nowSec - oldestTs);

  const expectedGapSeconds = producersInWindow > 0 && totalBlocks > 0
    ? (windowSeconds / totalBlocks) * producersInWindow
    : 60;

  const newDetectThreshold = expectedGapSeconds * 2;
  const isNewInWindow = firstBlockTs > 0 && firstBlockTs > oldestTs + newDetectThreshold;
  const activeWindowStart = isNewInWindow ? firstBlockTs : oldestTs;
  const activeWindowSeconds = Math.max(
    expectedGapSeconds * 3,
    newestTs - activeWindowStart + expectedGapSeconds,
  );
  const activeRatio = windowSeconds > 0
    ? Math.min(activeWindowSeconds / windowSeconds, 1)
    : 1;

  const stakeShare = (isActiveSet && stakeMon != null && totalActiveStake > 0)
    ? stakeMon / totalActiveStake
    : 0;

  const personalGapSeconds = stakeShare > 0 && totalBlocks > 0
    ? windowSeconds / (totalBlocks * stakeShare)
    : expectedGapSeconds;

  const expectedBlocks = totalBlocks * stakeShare * activeRatio;

  let participationPct: number | null = null;
  if (expectedBlocks > 0) {
    participationPct = round1((blocksProduced / expectedBlocks) * 100);
  }

  let participationLong: number | null = null;
  if (stakeShare > 0 && cumulativeBlocksObserved > 0) {
    const expectedLong = cumulativeBlocksObserved * stakeShare;
    if (expectedLong >= 5) {
      participationLong = round1((cumulativeMinerBlocks / expectedLong) * 100);
    }
  }

  let health: ValidatorHealth;
  if (blocksProduced === 0) {
    health = 'missing';
  } else if (ageSeconds < personalGapSeconds * 2) {
    health = 'active';
  } else if (ageSeconds < personalGapSeconds * 5) {
    health = 'slow';
  } else {
    health = 'missing';
  }

  const sharePct = totalBlocks > 0
    ? round1((blocksProduced / totalBlocks) * 100)
    : 0;

  return {
    ageSeconds,
    isNewInWindow,
    activeWindowSeconds,
    activeRatio,
    expectedGapSeconds,
    personalGapSeconds,
    expectedBlocks,
    participationPct,
    participationLong,
    health,
    sharePct,
  };
}

/**
 * Sum snapshotStake across the canonical active set. **Iterates per-ID
 * chain data** (not auth-deduped registry entries) — multi-ID operators
 * contribute each ID's stake separately. Reading from the auth-deduped
 * registry would systematically undercount totalActiveStake by ~25-40% on
 * mainnet-like topologies (every multi-ID operator's "extra" IDs would be
 * lost to Map.set deduplication).
 *
 * Falls back to stake-threshold heuristic during cold-start when
 * getConsensusValidatorSet() hasn't yet returned.
 */
export function computeTotalActiveStake(
  chainDataById: Map<number, { authAddress: string; stakeMon: number }>,
  consensusIds: Set<number>,
  fallbackThreshold = 10_000_000,
): number {
  const useCanonical = consensusIds.size > 0;
  let total = 0;
  for (const [id, data] of chainDataById) {
    const inSet = useCanonical
      ? consensusIds.has(id)
      : (data.stakeMon ?? 0) >= fallbackThreshold;
    if (inSet) total += data.stakeMon ?? 0;
  }
  return total;
}

/**
 * Auth-level aggregate: snapshot stake summed across every validator ID owned
 * by the given authAddress, plus the list of IDs (for UI surfacing
 * "N validator IDs" annotations).
 *
 * This is the correct denominator/numerator basis for participation when
 * blocks are attributed at the authAddress level (LIST behaviour). Using
 * a single ID's stake while attributing blocks across all IDs causes
 * 4-5× over-reporting for operators like Category Labs (4 IDs under one
 * auth, blocksProduced is summed but stakeMon was a single ID's slice).
 */
export function computeAuthStake(
  authAddress: string,
  chainDataById: Map<number, { authAddress: string; stakeMon: number }>,
  consensusIds: Set<number>,
): { stakeMon: number; validatorIds: number[]; activeIds: number[] } {
  const target = authAddress.toLowerCase();
  let stakeMon = 0;
  const validatorIds: number[] = [];
  const activeIds: number[] = [];
  for (const [id, data] of chainDataById) {
    if (data.authAddress.toLowerCase() !== target) continue;
    validatorIds.push(id);
    stakeMon += data.stakeMon ?? 0;
    if (consensusIds.has(id)) activeIds.push(id);
  }
  validatorIds.sort((a, b) => a - b);
  activeIds.sort((a, b) => a - b);
  return { stakeMon, validatorIds, activeIds };
}

/**
 * Active-set membership predicate. Canonical when consensusIds is populated
 * (post-cold-start); stake-threshold fallback otherwise.
 */
export function isInActiveSet(
  validatorId: number | null | undefined,
  stakeMon: number | null,
  consensusIds: Set<number>,
  fallbackThreshold = 10_000_000,
): boolean {
  if (consensusIds.size > 0) {
    return validatorId != null && consensusIds.has(validatorId);
  }
  return (stakeMon ?? 0) >= fallbackThreshold;
}

/**
 * Composite 0–100 score: 40% health × 40% uptime × 20% recency. Both list
 * and detail share this formula; centralised so the weights stay aligned
 * with [[validator-scoring-semantics]].
 */
export function computeValidatorScore(args: {
  health: ValidatorHealth;
  participationPct: number | null;
  ageSeconds: number;
  personalGapSeconds: number;
  registered: boolean;        // false → 0.7× penalty (unregistered signers)
}): number {
  const healthScore = args.health === 'active' ? 100 : args.health === 'slow' ? 40 : 0;
  const uptimeScore = Math.min(args.participationPct ?? 0, 100);
  const maxAge = args.personalGapSeconds * 5;
  const recencyScore = maxAge > 0
    ? Math.max(0, (1 - args.ageSeconds / maxAge)) * 100
    : 0;
  const raw = healthScore * 0.4 + uptimeScore * 0.4 + recencyScore * 0.2;
  const penalty = args.registered ? 1 : 0.7;
  return Math.round(raw * penalty);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
