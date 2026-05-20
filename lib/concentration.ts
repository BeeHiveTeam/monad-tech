/**
 * Stake-concentration math: Nakamoto coefficient, Lorenz curve, Gini.
 *
 * Shared between /api/network-health (existing nakamoto block) and the new
 * /api/network/concentration deep-dive. Keeping the math in one place avoids
 * a repeat of the participationPct LIST/DETAIL divergence we caught in May.
 */

export interface NakamotoEntry {
  n: number;        // min validators whose cumulative stake exceeds threshold
  cumPct: number;   // their combined % of total stake
}

export interface OperatorEntry {
  authAddress: string;
  moniker: string | null;
  stakeMon: number;
  sharePct: number;
  cumulativeSharePct: number;
  validatorIds: number[];
}

/**
 * Nakamoto coefficient: minimum N validators whose combined stake exceeds
 * `threshold` of the total. For BFT chains: 1/3 = liveness halt, 2/3 =
 * safety control. `sortedDesc` MUST be sorted descending by stake.
 */
export function nakamotoCoefficient(sortedDesc: number[], threshold: number): NakamotoEntry {
  const total = sortedDesc.reduce((s, v) => s + v, 0);
  if (total === 0) return { n: 0, cumPct: 0 };
  let cum = 0;
  for (let i = 0; i < sortedDesc.length; i++) {
    cum += sortedDesc[i];
    if (cum > total * threshold) {
      return { n: i + 1, cumPct: round1((cum / total) * 100) };
    }
  }
  return { n: sortedDesc.length, cumPct: 100 };
}

/**
 * Gini coefficient over stakes. 0 = perfect equality, 1 = one operator has
 * everything. For PoS chains, healthy ranges are usually 0.3–0.5; >0.7 is
 * a concentration warning signal.
 *
 * Formula: G = (Σᵢ Σⱼ |xᵢ − xⱼ|) / (2 n Σᵢ xᵢ)
 */
export function giniCoefficient(stakes: number[]): number {
  if (stakes.length <= 1) return 0;
  const total = stakes.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  // Sort ascending for the cumulative formulation
  // G = (Σᵢ (2i − n − 1) xᵢ) / (n × Σᵢ xᵢ), where xᵢ is the i-th value in ascending order
  const sortedAsc = [...stakes].sort((a, b) => a - b);
  const n = sortedAsc.length;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sortedAsc[i];
  }
  return Math.max(0, Math.min(1, numerator / (n * total)));
}

/**
 * Default stake threshold for the "is this validator in the active set"
 * fallback heuristic when canonical consensusIds aren't loaded yet. Mirrors
 * the value in validatorMetrics.ts:computeTotalActiveStake — kept in sync
 * here so concentration math and per-validator math don't drift apart
 * (see [[feedback_extract_helper_before_second_copy]]).
 */
export const ACTIVE_SET_STAKE_FALLBACK_MON = 10_000_000;

/**
 * Roll up per-validator-ID stakes into per-operator (per authAddress) stakes.
 * Multi-ID operators (e.g. Category Labs running 4 IDs under one auth) are
 * collapsed to a single entry with summed stake and all validatorIds listed.
 *
 * Output is sorted descending by stake, with cumulative-share computed for
 * the Lorenz curve. `monikerFn` should resolve auth address → moniker.
 */
export function operatorRollup(
  chainData: Map<number, { authAddress: string; stakeMon: number }>,
  consensusIds: Set<number>,
  monikerFn: (addr: string) => string | null,
): { operators: OperatorEntry[]; totalStake: number } {
  const useCanonical = consensusIds.size > 0;
  const byAuth = new Map<string, { stakeMon: number; validatorIds: number[] }>();
  for (const [id, data] of chainData) {
    const inSet = useCanonical ? consensusIds.has(id) : (data.stakeMon ?? 0) >= ACTIVE_SET_STAKE_FALLBACK_MON;
    if (!inSet) continue;
    const auth = data.authAddress.toLowerCase();
    const entry = byAuth.get(auth) ?? { stakeMon: 0, validatorIds: [] };
    entry.stakeMon += data.stakeMon ?? 0;
    entry.validatorIds.push(id);
    byAuth.set(auth, entry);
  }
  const totalStake = [...byAuth.values()].reduce((s, e) => s + e.stakeMon, 0);
  const sorted = [...byAuth.entries()]
    .map(([authAddress, e]) => ({
      authAddress,
      moniker: monikerFn(authAddress),
      stakeMon: e.stakeMon,
      validatorIds: [...e.validatorIds].sort((a, b) => a - b),
      sharePct: totalStake > 0 ? round2((e.stakeMon / totalStake) * 100) : 0,
      cumulativeSharePct: 0,
    }))
    .sort((a, b) => b.stakeMon - a.stakeMon);
  let cum = 0;
  for (const op of sorted) {
    cum += op.sharePct;
    op.cumulativeSharePct = round2(cum);
  }
  return { operators: sorted, totalStake };
}

/**
 * Lorenz curve points — (cumulative operator %, cumulative stake %) tuples.
 * X axis is operator rank percentile, Y axis is cumulative stake share. The
 * diagonal y=x represents perfect equality.
 */
export function lorenzCurve(operators: OperatorEntry[]): Array<{ x: number; y: number }> {
  if (operators.length === 0) return [];
  // Sort ascending by stake for the Lorenz curve (smallest first)
  const asc = [...operators].sort((a, b) => a.stakeMon - b.stakeMon);
  const total = asc.reduce((s, op) => s + op.stakeMon, 0);
  const n = asc.length;
  const points: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let cumStake = 0;
  for (let i = 0; i < n; i++) {
    cumStake += asc[i].stakeMon;
    points.push({
      x: round2(((i + 1) / n) * 100),
      y: total > 0 ? round2((cumStake / total) * 100) : 0,
    });
  }
  return points;
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
function round2(x: number): number { return Math.round(x * 100) / 100; }
