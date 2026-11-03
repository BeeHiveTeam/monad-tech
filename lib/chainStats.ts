/** Rates use the same half-open window for transactions and elapsed chain time. */
export interface SampledBlock {
  number: number;
  ts: number;
  txCount: number | null;
  gasUsed: number;
  gasLimit: number;
}

export function computeChainStats(rows: SampledBlock[]) {
  // New heads may arrive before transaction enrichment. Use the newest
  // completed suffix instead of recording an unknown tx count as zero.
  const firstComplete = rows.findIndex(b => b.txCount != null);
  const sample = firstComplete >= 0 ? rows.slice(firstComplete) : [];
  const span = sample.length > 1 ? sample[0].ts - sample[sample.length - 1].ts : 0;
  const consecutive = sample.every((b, i) => i === 0 || sample[i - 1].number === b.number + 1);
  const measured = sample.slice(0, -1);
  const complete = measured.length > 0 && consecutive && span > 0
    && measured.every(b => b.txCount != null && Number.isFinite(b.txCount) && b.txCount >= 0);
  const totalTx = complete ? measured.reduce((s, b) => s + b.txCount!, 0) : null;
  const headerSpan = rows.length > 1 ? rows[0].ts - rows[rows.length - 1].ts : 0;
  const headersConsecutive = rows.every((b, i) => i === 0 || rows[i - 1].number === b.number + 1);
  const utilization = rows.filter(b => Number.isFinite(b.gasUsed) && b.gasLimit > 0)
    .map(b => b.gasUsed / b.gasLimit);
  return {
    tps: totalTx != null ? totalTx / span : null,
    avgBlockTime: headersConsecutive && headerSpan > 0 ? headerSpan / (rows.length - 1) : null,
    avgGasUtilization: utilization.length ? utilization.reduce((a, b) => a + b, 0) / utilization.length * 100 : null,
    sampleSize: rows.length,
    tpsWindowSeconds: complete ? span : null,
    tpsTransactions: totalTx,
    tpsMethod: 'chain-time-half-open' as const,
  };
}
