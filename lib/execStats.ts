/**
 * Parser for monad-execution `__exec_block` log lines.
 * Each committed block emits one line like:
 *   __exec_block,bl=27329782,id=0x9eaf...,ts=1776959937600,tx=3,rt=1,rtp=33.33%,
 *   sr=39µs,txe=676µs,cmt=629µs,tot=1368µs,tpse=4437,tps=2192,
 *   gas=1424902,gpse=2107,gps=1041,ac=1466,sc=120794
 *
 * These lines are source of truth for Monad's parallel-execution behavior:
 *   rtp = % of transactions re-executed due to parallelism conflicts
 *   sr/txe/cmt/tot = per-phase latency breakdown (state_reset / tx_exec / commit)
 *   tpse/gpse = effective peak TPS / gas-per-sec observed inside this block
 */

const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';
const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

export interface ExecStat {
  block: number;
  hash: string;
  ts: number;          // block timestamp (ms)
  tx: number;          // transactions in block
  rt: number;          // retried transactions
  rtp: number;         // retry percentage (0-100)
  sr: number;          // state_reset time (µs)
  txe: number;         // tx_exec time (µs)
  cmt: number;         // commit time (µs)
  tot: number;         // total execution time (µs)
  tpse: number;        // effective peak TPS
  tps: number;         // sustained TPS
  gas: number;         // gas used
  gpse: number;        // effective peak gas/sec
  gps: number;         // sustained gas/sec
}

const EXEC_RE =
  /__exec_block,bl=(\d+),id=(0x[0-9a-fA-F]+),ts=(\d+),tx=\s*(\d+),rt=\s*(\d+),rtp=\s*([\d.]+)%,sr=\s*(\d+)µs,txe=\s*(\d+)µs,cmt=\s*(\d+)µs,tot=\s*(\d+)µs,tpse=\s*(\d+),tps=\s*(\d+),gas=\s*(\d+),gpse=\s*(\d+),gps=\s*(\d+)/;

export function parseExecLine(line: string): ExecStat | null {
  const m = line.match(EXEC_RE);
  if (!m) return null;
  return {
    block: +m[1],
    hash: m[2],
    ts: +m[3],
    tx: +m[4],
    rt: +m[5],
    rtp: parseFloat(m[6]),
    sr: +m[7],
    txe: +m[8],
    cmt: +m[9],
    tot: +m[10],
    tpse: +m[11],
    tps: +m[12],
    gas: +m[13],
    gpse: +m[14],
    gps: +m[15],
  };
}

/**
 * Fetch exec stats from Loki over a time range. Returns oldest-first.
 * `limit` caps response size (Loki hard max is 5000).
 */
export async function fetchExecStats(
  rangeSeconds: number,
  limit: number = 5000,
): Promise<ExecStat[]> {
  const end = Date.now() * 1_000_000;           // ns
  const start = end - rangeSeconds * 1e9;       // ns
  const query = '{service_name="monad-execution"} |~ "__exec_block"';

  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}`
    + `&start=${Math.floor(start)}&end=${Math.floor(end)}`
    + `&limit=${limit}&direction=forward`;

  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Loki ${r.status}: ${await r.text()}`);
  const data = await r.json() as {
    data?: { result?: Array<{ values: Array<[string, string]> }> };
  };

  const out: ExecStat[] = [];
  const seen = new Set<number>();
  for (const stream of data.data?.result ?? []) {
    for (const [, line] of stream.values ?? []) {
      const parsed = parseExecLine(line);
      if (parsed && !seen.has(parsed.block)) {
        seen.add(parsed.block);
        out.push(parsed);
      }
    }
  }
  out.sort((a, b) => a.block - b.block);
  return out;
}

/**
 * Downsample to at most `maxPoints` buckets by averaging within equal-width time bins.
 * Used for wider ranges (6h/12h/24h) to keep response sizes sane.
 */
export function downsample(stats: ExecStat[], maxPoints: number): ExecStat[] {
  if (stats.length <= maxPoints) return stats;
  const bucketSize = Math.ceil(stats.length / maxPoints);
  const out: ExecStat[] = [];
  for (let i = 0; i < stats.length; i += bucketSize) {
    const chunk = stats.slice(i, i + bucketSize);
    const sum = (k: keyof ExecStat) => chunk.reduce((a, s) => a + (s[k] as number), 0);
    const avg = (k: keyof ExecStat) => sum(k) / chunk.length;
    const last = chunk[chunk.length - 1];
    out.push({
      block: last.block,
      hash: last.hash,
      ts: Math.round(avg('ts')),
      tx: Math.round(avg('tx')),
      rt: Math.round(avg('rt')),
      rtp: +avg('rtp').toFixed(2),
      sr: Math.round(avg('sr')),
      txe: Math.round(avg('txe')),
      cmt: Math.round(avg('cmt')),
      tot: Math.round(avg('tot')),
      tpse: Math.round(avg('tpse')),
      tps: Math.round(avg('tps')),
      gas: Math.round(avg('gas')),
      gpse: Math.round(avg('gpse')),
      gps: Math.round(avg('gps')),
    });
  }
  return out;
}

export interface ExecSummary {
  count: number;
  rtpAvg: number;
  rtpPeak: number;
  rtpP95: number;
  totAvg: number;      // avg total exec µs
  tpseAvg: number;     // avg effective peak TPS
  tpsePeak: number;    // max effective peak TPS
  gpseAvg: number;
  gpsePeak: number;
  blocksWithRetries: number;   // blocks where rt > 0
  retriesShare: number;        // % of blocks with retries
}

// -- InfluxDB persistence ----------------------------------------------------
// Loki retention is 7d and queries for >15min of exec_block logs time out.
// We write every new block's exec stats to InfluxDB `monad_exec` (measurement)
// tagged by network. This lets /api/exec-stats read from Influx for ranges
// beyond what Loki can serve, with effectively unbounded history.

interface WriterState { lastBlock: number }
const gW = globalThis as { __monadExecWriter__?: WriterState };
if (!gW.__monadExecWriter__) gW.__monadExecWriter__ = { lastBlock: 0 };

async function influxWriteRaw(lines: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines,
      signal: AbortSignal.timeout(4_000),
    });
  } catch { /* non-critical: next tick retries */ }
}

function toLineProtocol(e: ExecStat, network: string): string {
  // Network is a tag (low cardinality). Block is a field (high cardinality —
  // would blow up InfluxDB indexes if it were a tag). All other values fields.
  return `monad_exec,network=${network} ` +
    `block=${e.block}i,tx=${e.tx}i,rt=${e.rt}i,rtp=${e.rtp},` +
    `sr=${e.sr}i,txe=${e.txe}i,cmt=${e.cmt}i,tot=${e.tot}i,` +
    `tpse=${e.tpse}i,tps=${e.tps}i,gas=${e.gas}i,gpse=${e.gpse}i,gps=${e.gps}i ` +
    `${e.ts}`;
}

/**
 * Background poller: fetches last ~90s of exec stats from Loki and writes
 * only blocks we haven't written yet into InfluxDB. Called from instrumentation.
 */
export async function tickExecWriter(network: string = 'testnet'): Promise<void> {
  try {
    const recent = await fetchExecStats(90, 5000);
    if (recent.length === 0) return;

    const state = gW.__monadExecWriter__!;
    // On first run, skip backfill: start fresh from the newest block and
    // only write going forward. Otherwise write everything newer.
    if (state.lastBlock === 0) {
      state.lastBlock = recent[recent.length - 1].block - 1;
    }
    const toWrite = recent.filter(e => e.block > state.lastBlock);
    if (toWrite.length === 0) return;

    const body = toWrite.map(e => toLineProtocol(e, network)).join('\n');
    await influxWriteRaw(body);
    state.lastBlock = toWrite[toWrite.length - 1].block;
  } catch { /* swallow */ }
}

/**
 * Read exec stats from InfluxDB for a given time range. Returns oldest-first
 * ExecStat[]. Used for ranges that exceed Loki's practical query window.
 */
export async function fetchExecStatsFromInflux(
  rangeSeconds: number,
  network: string = 'testnet',
): Promise<ExecStat[]> {
  const q = `SELECT block,tx,rt,rtp,sr,txe,cmt,tot,tpse,tps,gas,gpse,gps ` +
    `FROM monad_exec ` +
    `WHERE network='${network}' AND time > now()-${rangeSeconds}s ` +
    `ORDER BY time ASC`;
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}&epoch=ms`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const json = await res.json() as {
      results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>;
    };
    const series = json.results?.[0]?.series?.[0];
    if (!series?.values?.length) return [];

    const idx: Record<string, number> = {};
    series.columns.forEach((c, i) => { idx[c] = i; });
    const num = (row: unknown[], k: string) => Number(row[idx[k]] ?? 0);

    return series.values.map(row => ({
      block: num(row, 'block'),
      hash: '',                                  // not stored — keep empty
      ts: Number(row[idx.time]),
      tx: num(row, 'tx'),
      rt: num(row, 'rt'),
      rtp: num(row, 'rtp'),
      sr: num(row, 'sr'),
      txe: num(row, 'txe'),
      cmt: num(row, 'cmt'),
      tot: num(row, 'tot'),
      tpse: num(row, 'tpse'),
      tps: num(row, 'tps'),
      gas: num(row, 'gas'),
      gpse: num(row, 'gpse'),
      gps: num(row, 'gps'),
    }));
  } catch {
    return [];
  }
}

export function summarize(stats: ExecStat[]): ExecSummary {
  if (stats.length === 0) {
    return {
      count: 0, rtpAvg: 0, rtpPeak: 0, rtpP95: 0,
      totAvg: 0, tpseAvg: 0, tpsePeak: 0, gpseAvg: 0, gpsePeak: 0,
      blocksWithRetries: 0, retriesShare: 0,
    };
  }
  // Single pass — avoids spread `...array` which overflows the JS call stack
  // when stats.length is large (24h range has ~200k blocks; V8 spread limit is
  // ~125k arguments). Also avoids allocating separate arrays for each metric.
  let rtpSum = 0, rtpPeak = 0;
  let totSum = 0;
  let tpseSum = 0, tpsePeak = 0;
  let gpseSum = 0, gpsePeak = 0;
  let blocksWithRetries = 0;
  const rtpValues = new Array<number>(stats.length);
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    rtpValues[i] = s.rtp;
    rtpSum += s.rtp; if (s.rtp > rtpPeak) rtpPeak = s.rtp;
    totSum += s.tot;
    tpseSum += s.tpse; if (s.tpse > tpsePeak) tpsePeak = s.tpse;
    gpseSum += s.gpse; if (s.gpse > gpsePeak) gpsePeak = s.gpse;
    if (s.rt > 0) blocksWithRetries++;
  }
  rtpValues.sort((a, b) => a - b);
  const n = stats.length;
  return {
    count: n,
    rtpAvg: +(rtpSum / n).toFixed(2),
    rtpPeak: +rtpPeak.toFixed(2),
    rtpP95: +rtpValues[Math.floor(n * 0.95)].toFixed(2),
    totAvg: Math.round(totSum / n),
    tpseAvg: Math.round(tpseSum / n),
    tpsePeak,
    gpseAvg: Math.round(gpseSum / n),
    gpsePeak,
    blocksWithRetries,
    retriesShare: +((blocksWithRetries / n) * 100).toFixed(2),
  };
}
