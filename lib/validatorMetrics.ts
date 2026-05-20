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

/**
 * Six-axis composite score (Stakewiz Wiz-Score / Rated RAVER / Trillium-inspired).
 * Each axis is 0–100; composite is a weighted mean. Axes are exposed separately
 * so the UI can render a radar chart and operators can see *why* their score
 * moved (e.g. "Decentralization dropped 12pt — your AS now controls >25% stake").
 *
 * Weights mirror Stakewiz's empirical tuning, adjusted for Monad's data model:
 * we don't yet have MEV, vote-latency, or epoch-distance signals — those will
 * be added later. Until then, weights sum to 1.00 across the 6 axes we can
 * compute deterministically from on-chain data + registry metadata.
 */
export interface CompositeScoreInput {
  // Reliability axis — straight from computeValidatorMetrics
  health: ValidatorHealth;
  participationPct: number | null;
  participationLong: number | null;
  ageSeconds: number;
  personalGapSeconds: number;
  // Production / decentralization
  stakeMon: number | null;
  totalActiveStake: number;
  isActiveSet: boolean;
  registered: boolean;
  // Ops maturity
  hasSecp: boolean;            // info.secp present → consensus key registered
  // Returns proxy (until ValidatorRewarded-derived TrueAPY ships)
  commissionPct: number | null;
  // Info completeness (from validator-monikers info struct)
  hasMoniker: boolean;
  hasWebsite: boolean;
  hasDescription: boolean;
  hasLogo: boolean;
  hasSocial: boolean;
}

export interface CompositeScoreOutput {
  composite: number;
  axes: {
    reliability: number;
    production: number;
    returns: number;
    decentralization: number;
    opsMaturity: number;
    infoScore: number;
  };
}

const COMPOSITE_WEIGHTS = {
  reliability: 0.20,
  production: 0.20,
  returns: 0.15,
  decentralization: 0.15,
  opsMaturity: 0.15,
  infoScore: 0.15,
};

export function computeCompositeScore(input: CompositeScoreInput): CompositeScoreOutput {
  // 1. Reliability — same shape as legacy computeValidatorScore (health×uptime×recency).
  const healthScore = input.health === 'active' ? 100 : input.health === 'slow' ? 40 : 0;
  // Prefer long-window participation when available (≥5 expected blocks observed);
  // it's less jittery than the 500-block window for low-stake validators.
  const uptimeRaw = input.participationLong ?? input.participationPct ?? 0;
  const uptimeScore = Math.min(uptimeRaw, 100);
  const maxAge = input.personalGapSeconds * 5;
  const recencyScore = maxAge > 0
    ? Math.max(0, (1 - input.ageSeconds / maxAge)) * 100
    : 0;
  const reliability = healthScore * 0.4 + uptimeScore * 0.4 + recencyScore * 0.2;

  // 2. Production — how close participation is to 100% expected. Over-prod
  //    isn't penalised heavily (capped at 100 with mild taper to 90 at 130%+),
  //    under-prod is proportional. Brand-new validators (participation null)
  //    get a neutral 50 to avoid penalising bootstrap.
  let production: number;
  if (input.participationPct == null) {
    production = 50;
  } else {
    const p = input.participationPct;
    if (p >= 100) {
      // taper: 100% → 100, 130% → 90, 200% → 70
      production = Math.max(60, 100 - (p - 100) * 0.3);
    } else {
      // 100% → 100, 80% → 80, 50% → 50, 0% → 0
      production = Math.max(0, p);
    }
  }

  // 3. Returns — inverse of commission for now (delegator-perspective:
  //    lower commission ≈ higher realised yield). VDP cap is 15%; we map
  //    0% → 100, 15% → 50, ≥30% → 0. Replace with TrueAPY = median realised
  //    rewards / stake once the ValidatorRewarded scanner is in the hot path.
  let returns: number;
  if (input.commissionPct == null) {
    returns = 50;
  } else {
    const c = Math.max(0, input.commissionPct);
    returns = Math.max(0, 100 - (c / 15) * 50);
  }

  // 4. Decentralization — penalises whale concentration. stakeShare 0% → 100,
  //    1% → 90, 5% → 50, 10%+ → 10 (asymptote, never 0 — even huge validators
  //    contribute some baseline security). Inactive/no-stake validators score
  //    neutral 50 (consistent with Production/Returns missing-data treatment);
  //    they don't contribute centralisation risk but also don't contribute
  //    decentralisation evidence. Pre-fix this returned 100 for inactive
  //    validators, artificially inflating composite scores for brand-new or
  //    de-registered validators — fixed per audit H5.
  let decentralization: number;
  if (!input.isActiveSet || !input.stakeMon || input.totalActiveStake <= 0) {
    decentralization = 50;
  } else {
    const sharePct = (input.stakeMon / input.totalActiveStake) * 100;
    // 0%→100, 1%→90, 2%→80, 5%→50, 10%→0 (clamped)
    decentralization = Math.max(0, 100 - sharePct * 10);
  }

  // 5. Ops Maturity — weighted bool checklist of operational hygiene signals.
  let opsMaturity = 0;
  if (input.registered) opsMaturity += 30;          // staked in precompile
  if (input.isActiveSet) opsMaturity += 25;         // passes snapshot threshold
  if (input.hasSecp) opsMaturity += 20;             // consensus key on-chain
  // Long-window participation present ⇒ been around for ≥5 expected blocks ⇒ not brand-new.
  if (input.participationLong != null) opsMaturity += 15;
  // Reasonable commission (0–15%, VDP-compliant). Pure 0% gets full credit
  // (foundation/early validators); 16%+ loses these points.
  if (input.commissionPct != null && input.commissionPct >= 0 && input.commissionPct <= 15) {
    opsMaturity += 10;
  }

  // 6. Info score — metadata completeness from validator-monikers.
  let infoScore = 0;
  if (input.hasMoniker)     infoScore += 25;
  if (input.hasWebsite)     infoScore += 20;
  if (input.hasDescription) infoScore += 20;
  if (input.hasLogo)        infoScore += 20;
  if (input.hasSocial)      infoScore += 15;

  // Compute composite from RAW (pre-rounding) values, then round once at end.
  // Rounding axes first compounded error up to ±3 score points across 6 axes —
  // fixed per audit H4. The displayed axes are still ints (UI doesn't show
  // fractions), but the composite is now mathematically faithful.
  const composite = Math.round(
    reliability      * COMPOSITE_WEIGHTS.reliability +
    production       * COMPOSITE_WEIGHTS.production +
    returns          * COMPOSITE_WEIGHTS.returns +
    decentralization * COMPOSITE_WEIGHTS.decentralization +
    opsMaturity      * COMPOSITE_WEIGHTS.opsMaturity +
    infoScore        * COMPOSITE_WEIGHTS.infoScore
  );

  const axes = {
    reliability: Math.round(reliability),
    production: Math.round(production),
    returns: Math.round(returns),
    decentralization: Math.round(decentralization),
    opsMaturity: Math.round(opsMaturity),
    infoScore: Math.round(infoScore),
  };

  return { composite, axes };
}
