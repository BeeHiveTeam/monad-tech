/**
 * Block cadence — how evenly blocks actually arrive.
 *
 * WHY THIS IS NOT A ONE-LINER
 * ---------------------------
 * Monad targets sub-second blocks (~0.3-0.4 s observed on mainnet). On-chain
 * `block.timestamp` is UNIX SECONDS, so consecutive blocks differ by 0 or 1 —
 * measured on our own /api/blocks: [1, 0, 1, 0]. You can recover a useful
 * AVERAGE from that (span / count, over a long enough window), but you cannot
 * recover per-block jitter: the quantisation noise (±500 ms) is larger than the
 * quantity being measured.
 *
 * This matters because other Monad dashboards publish a "block time variance"
 * in milliseconds next to a second-resolution timestamp. That number cannot
 * come from chain data; it is either their own polling cadence or noise.
 * We refuse to publish a figure we cannot source, so:
 *
 *   - `avgIntervalMs`  — computed from chain timestamps over a wide window.
 *                        Valid: quantisation averages out across many blocks.
 *   - `jitterMs` & co. — computed ONLY from `receivedAt`, the millisecond
 *                        wall-clock stamp our WebSocket writes when a newHeads
 *                        push lands. Honest label: this is arrival cadence at
 *                        our node, which includes network latency — it is NOT
 *                        consensus timing. Null when that source is absent.
 *
 * The WS ring buffer only runs for testnet (see app/api/blocks/route.ts), so
 * mainnet gets `source: 'chain-seconds'` and null jitter rather than a guess.
 */

export type CadenceSource = 'ws-arrival' | 'chain-seconds';

export interface BlockCadence {
  sampleSize: number;            // number of intervals used (blocks - 1)
  avgIntervalMs: number | null;
  medianIntervalMs: number | null;
  jitterMs: number | null;       // stddev of intervals; null if not measurable
  p95IntervalMs: number | null;
  /** % of intervals landing within ±50% of the median. Null if not measurable. */
  stabilityScore: number | null;
  source: CadenceSource;
  /** Plain-language caveat for the UI; never show the numbers without it. */
  note: string;
}

const EMPTY = (source: CadenceSource, note: string): BlockCadence => ({
  sampleSize: 0, avgIntervalMs: null, medianIntervalMs: null,
  jitterMs: null, p95IntervalMs: null, stabilityScore: null, source, note,
});

/**
 * Consecutive-only gaps. A skipped height (reorg, or a block the ring never
 * saw) would otherwise show up as a double-length interval and pollute both
 * the mean and the stddev.
 */
function consecutiveGaps(
  rows: Array<{ number: number; at: number }>,
): number[] {
  const asc = [...rows].sort((a, b) => a.number - b.number);
  const gaps: number[] = [];
  for (let i = 1; i < asc.length; i++) {
    if (asc[i].number !== asc[i - 1].number + 1) continue;
    const d = asc[i].at - asc[i - 1].at;
    if (d > 0) gaps.push(d);
  }
  return gaps;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Full metrics from millisecond arrival stamps (WS ring buffer).
 */
export function cadenceFromArrivals(
  blocks: Array<{ number: number; receivedAt: number }>,
): BlockCadence {
  const note =
    'Arrival cadence measured at our node (WebSocket newHeads). Includes network latency — not consensus block time.';
  const gaps = consecutiveGaps(blocks.map(b => ({ number: b.number, at: b.receivedAt })));
  if (gaps.length < 2) return EMPTY('ws-arrival', note);

  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const median = quantile(sorted, 0.5);
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;

  // Share of intervals inside ±50% of the median. Chosen over a raw
  // coefficient of variation because a single long stall (node restart,
  // dropped WS frame) would dominate a stddev-based score while barely
  // moving a share-based one.
  const lo = median * 0.5;
  const hi = median * 1.5;
  const within = gaps.filter(g => g >= lo && g <= hi).length;

  return {
    sampleSize: gaps.length,
    avgIntervalMs: Math.round(mean),
    medianIntervalMs: Math.round(median),
    jitterMs: Math.round(Math.sqrt(variance)),
    p95IntervalMs: Math.round(quantile(sorted, 0.95)),
    stabilityScore: Math.round((within / gaps.length) * 100),
    source: 'ws-arrival',
    note,
  };
}

/**
 * Average only, from second-resolution chain timestamps.
 * Deliberately returns null for every dispersion metric — see file header.
 */
export function cadenceFromChainSeconds(
  blocks: Array<{ number: number; timestamp: number }>,
): BlockCadence {
  const note =
    'Average only: chain timestamps are whole seconds, so per-block jitter is not measurable from them.';
  const asc = [...blocks].sort((a, b) => a.number - b.number);
  if (asc.length < 2) return EMPTY('chain-seconds', note);

  const first = asc[0];
  const last = asc[asc.length - 1];
  const spanSec = last.timestamp - first.timestamp;
  const heights = last.number - first.number;
  if (heights <= 0 || spanSec <= 0) return EMPTY('chain-seconds', note);

  // Quantisation error is ±1 s across the whole span, so the average is only
  // trustworthy once the span is many seconds wide. Below that, say nothing.
  if (spanSec < 5) return EMPTY('chain-seconds', note);

  return {
    sampleSize: heights,
    avgIntervalMs: Math.round((spanSec * 1000) / heights),
    medianIntervalMs: null,
    jitterMs: null,
    p95IntervalMs: null,
    stabilityScore: null,
    source: 'chain-seconds',
    note,
  };
}
