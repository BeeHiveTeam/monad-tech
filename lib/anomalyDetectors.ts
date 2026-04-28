/**
 * Anomaly detectors — promote node-level observability signals into the
 * public IncidentTimeline. All detected events are persisted to InfluxDB
 * measurement `monad_anomalies` so they survive PM2 restarts and can be
 * read by the unified incident feed.
 *
 * Five detector types:
 *   1. state_root_mismatch — counter delta on cs_rx_bad_state_root (critical)
 *   2. state_sync_active   — gauge 0↔1 transitions on monad_statesync_syncing
 *   3. consensus_stress    — TC/(QC+TC) ratio in 5min window > 20%
 *   4. vote_delay_high     — vote_delay p99_ms > 300ms sustained for 5 ticks
 *   5. tip_lag             — local exec head behind reference RPC by >5 blocks
 *
 * All detectors run on the same 30s tick. Edge-triggered (fire on entering
 * alerting state) to avoid spam — recovery is implied by absence of new events.
 */

import { parsePrometheus, findOne } from './prom-parser';

const METRICS_URL = process.env.NODE_METRICS_URL || 'http://15.235.117.52:8889/metrics';
const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';
const REFERENCE_RPC = process.env.MONAD_REFERENCE_RPC || 'https://testnet-rpc.monad.xyz';
const LOCAL_RPC = process.env.MONAD_RPC_URL || 'http://15.235.117.52:8080';

// Thresholds — tuned conservatively to avoid noise. Adjust after live calibration.
const CONSENSUS_STRESS_RATIO = 0.20;        // 20% TC ratio over 5min = stressed
const CONSENSUS_STRESS_WINDOW_MS = 5 * 60_000;
const CONSENSUS_STRESS_MIN_SAMPLES = 5;
const VOTE_DELAY_THRESHOLD_MS = 300;
const VOTE_DELAY_SUSTAINED_TICKS = 5;       // 5 × 30s = 2.5min sustained
const TIP_LAG_THRESHOLD_BLOCKS = 5;
const TIP_LAG_SUSTAINED_TICKS = 3;          // 3 × 30s = 90s sustained (avoids one-tick races)

export type AnomalyType =
  | 'state_root_mismatch'
  | 'state_sync_active'
  | 'consensus_stress'
  | 'vote_delay_high'
  | 'tip_lag';

export type AnomalySeverity = 'info' | 'warn' | 'critical';

export interface AnomalyEvent {
  ts: number;
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
}

interface DetectorState {
  // counter deltas
  prevBadStateRoot: number | null;
  // gauge transitions
  prevSyncing: number | null;
  // ratio window: rolling samples of tc/qc deltas
  prevTcCount: number | null;
  prevQcCount: number | null;
  ratioSamples: Array<{ ts: number; tcDelta: number; qcDelta: number }>;
  consensusStressActive: boolean;
  // sustained gauge counter
  voteDelayHighStreak: number;
  voteDelayActive: boolean;
  // tip lag streak
  tipLagStreak: number;
  tipLagActive: boolean;
}

const g = globalThis as unknown as { __monadAnomalyState__?: DetectorState };
if (!g.__monadAnomalyState__) {
  g.__monadAnomalyState__ = {
    prevBadStateRoot: null,
    prevSyncing: null,
    prevTcCount: null,
    prevQcCount: null,
    ratioSamples: [],
    consensusStressActive: false,
    voteDelayHighStreak: 0,
    voteDelayActive: false,
    tipLagStreak: 0,
    tipLagActive: false,
  };
}
const S = g.__monadAnomalyState__!;

// ── InfluxDB helpers ────────────────────────────────────────────────────────

function escapeStr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function writeAnomalyToInflux(e: AnomalyEvent): Promise<void> {
  try {
    const meta = e.meta ? JSON.stringify(e.meta) : '';
    const line = `monad_anomalies,network=testnet,type=${e.type} `
      + `severity="${e.severity}",`
      + `title="${escapeStr(e.title)}",`
      + `detail="${escapeStr(e.detail)}",`
      + `meta_json="${escapeStr(meta)}" `
      + `${e.ts}`;
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: line,
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* non-critical */ }
}

export async function fetchAnomaliesFromInflux(windowSeconds: number): Promise<AnomalyEvent[] | null> {
  try {
    const q = `SELECT type,severity,title,detail,meta_json FROM monad_anomalies `
      + `WHERE network='testnet' AND time > now()-${windowSeconds}s ORDER BY time ASC`;
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}&epoch=ms`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return null;
    const j = await res.json() as { results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }> };
    const s = j.results?.[0]?.series?.[0];
    if (!s?.values?.length) return [];
    const idx: Record<string, number> = {};
    s.columns.forEach((c, i) => { idx[c] = i; });
    return s.values.map(row => {
      let meta: Record<string, unknown> | undefined;
      const metaStr = String(row[idx.meta_json] ?? '');
      if (metaStr) {
        try { meta = JSON.parse(metaStr); } catch { /* ignore */ }
      }
      return {
        ts: Number(row[idx.time]),
        type: String(row[idx.type] ?? '') as AnomalyType,
        severity: String(row[idx.severity] ?? 'warn') as AnomalySeverity,
        title: String(row[idx.title] ?? ''),
        detail: String(row[idx.detail] ?? ''),
        meta,
      };
    });
  } catch { return null; }
}

// ── RPC helpers (used only by tip-lag detector) ─────────────────────────────

async function rpcBlockNumber(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: string };
    if (!j.result) return null;
    return parseInt(j.result, 16);
  } catch { return null; }
}

// ── Main tick: scrape Prometheus, run detectors, persist anomalies ──────────

export async function tickAnomalyDetectors(): Promise<void> {
  let promText: string;
  try {
    const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    if (!res.ok) return;
    promText = await res.text();
  } catch { return; }

  const samples = parsePrometheus(promText);
  const now = Date.now();
  const events: AnomalyEvent[] = [];

  // 1. state_root_mismatch (counter delta)
  const badStateRoot = findOne(samples, 'monad_state_consensus_events_rx_bad_state_root')?.value ?? null;
  if (badStateRoot !== null) {
    if (S.prevBadStateRoot !== null && badStateRoot > S.prevBadStateRoot) {
      const delta = badStateRoot - S.prevBadStateRoot;
      events.push({
        ts: now,
        type: 'state_root_mismatch',
        severity: 'critical',
        title: `State root mismatch · ${delta} new event(s)`,
        detail: `monad-bft received ${delta} block(s) with state-root different from locally computed. `
          + `Indicates execution-layer divergence — investigate immediately. Total lifetime: ${badStateRoot}.`,
        meta: { delta, total: badStateRoot },
      });
    }
    S.prevBadStateRoot = badStateRoot;
  }

  // 2. state_sync_active (gauge 0↔1)
  const syncing = findOne(samples, 'monad_statesync_syncing')?.value ?? null;
  if (syncing !== null) {
    if (S.prevSyncing !== null && S.prevSyncing !== syncing) {
      if (syncing === 1) {
        events.push({
          ts: now,
          type: 'state_sync_active',
          severity: 'critical',
          title: 'Node entered state sync',
          detail: 'monad_statesync_syncing went 0 → 1. Node is no longer validating — '
            + 'it is recovering from a state divergence or was offline. Block production paused.',
          meta: { transition: '0→1' },
        });
      } else {
        events.push({
          ts: now,
          type: 'state_sync_active',
          severity: 'info',
          title: 'Node exited state sync',
          detail: 'monad_statesync_syncing went 1 → 0. Node has caught up and resumed validation.',
          meta: { transition: '1→0' },
        });
      }
    }
    S.prevSyncing = syncing;
  }

  // 3. consensus_stress (rolling 5min ratio)
  const tcCount = findOne(samples, 'monad_state_consensus_events_enter_new_round_tc')?.value ?? null;
  const qcCount = findOne(samples, 'monad_state_consensus_events_enter_new_round_qc')?.value ?? null;
  if (tcCount !== null && qcCount !== null) {
    if (S.prevTcCount !== null && S.prevQcCount !== null) {
      const tcDelta = Math.max(0, tcCount - S.prevTcCount);
      const qcDelta = Math.max(0, qcCount - S.prevQcCount);
      S.ratioSamples.push({ ts: now, tcDelta, qcDelta });
    }
    // Drop samples outside the rolling window
    const cutoff = now - CONSENSUS_STRESS_WINDOW_MS;
    S.ratioSamples = S.ratioSamples.filter(s => s.ts >= cutoff);
    if (S.ratioSamples.length >= CONSENSUS_STRESS_MIN_SAMPLES) {
      const totalTc = S.ratioSamples.reduce((a, s) => a + s.tcDelta, 0);
      const totalQc = S.ratioSamples.reduce((a, s) => a + s.qcDelta, 0);
      const totalRounds = totalTc + totalQc;
      const ratio = totalRounds > 0 ? totalTc / totalRounds : 0;
      const isStressed = ratio >= CONSENSUS_STRESS_RATIO && totalRounds >= 50;
      if (isStressed && !S.consensusStressActive) {
        events.push({
          ts: now,
          type: 'consensus_stress',
          severity: 'warn',
          title: `Consensus stress · ${(ratio * 100).toFixed(1)}% rounds via TC`,
          detail: `Last 5min: ${totalTc}/${totalRounds} rounds entered via timeout certificate (${(ratio * 100).toFixed(1)}%). `
            + `Healthy networks stay <5%. Indicates the leader pipeline is timing out — slow propagation, peer churn, or unhealthy validators.`,
          meta: { ratio, totalTc, totalQc, totalRounds, windowSec: CONSENSUS_STRESS_WINDOW_MS / 1000 },
        });
        S.consensusStressActive = true;
      } else if (!isStressed) {
        S.consensusStressActive = false;
      }
    }
    S.prevTcCount = tcCount;
    S.prevQcCount = qcCount;
  }

  // 4. vote_delay_high (sustained gauge)
  const voteP99 = findOne(samples, 'monad_state_vote_delay_ready_after_timer_start_p99_ms')?.value ?? null;
  if (voteP99 !== null) {
    if (voteP99 > VOTE_DELAY_THRESHOLD_MS) {
      S.voteDelayHighStreak++;
      if (S.voteDelayHighStreak >= VOTE_DELAY_SUSTAINED_TICKS && !S.voteDelayActive) {
        events.push({
          ts: now,
          type: 'vote_delay_high',
          severity: 'warn',
          title: `Vote delay p99 elevated · ${voteP99.toFixed(0)}ms`,
          detail: `vote_delay_ready_after_timer_start p99 has been > ${VOTE_DELAY_THRESHOLD_MS}ms for `
            + `${S.voteDelayHighStreak * 30}s. Consensus is lagging — check peer mesh latency and CPU load.`,
          meta: { p99: voteP99, threshold: VOTE_DELAY_THRESHOLD_MS, streakTicks: S.voteDelayHighStreak },
        });
        S.voteDelayActive = true;
      }
    } else {
      S.voteDelayHighStreak = 0;
      S.voteDelayActive = false;
    }
  }

  // 5. tip_lag (local exec head vs reference RPC)
  const [localTip, refTip] = await Promise.all([
    rpcBlockNumber(LOCAL_RPC),
    rpcBlockNumber(REFERENCE_RPC),
  ]);
  if (localTip !== null && refTip !== null) {
    const lag = refTip - localTip;
    if (lag > TIP_LAG_THRESHOLD_BLOCKS) {
      S.tipLagStreak++;
      if (S.tipLagStreak >= TIP_LAG_SUSTAINED_TICKS && !S.tipLagActive) {
        events.push({
          ts: now,
          type: 'tip_lag',
          severity: lag > 50 ? 'critical' : 'warn',
          title: `Tip lag · ${lag} blocks behind testnet-rpc`,
          detail: `Local execution head (block ${localTip}) is ${lag} blocks behind reference RPC (block ${refTip}). `
            + `Sustained for ${S.tipLagStreak * 30}s. Possible causes: state sync, peer mesh issue, or execution lag.`,
          meta: { localTip, refTip, lag, streakTicks: S.tipLagStreak },
        });
        S.tipLagActive = true;
      }
    } else {
      S.tipLagStreak = 0;
      S.tipLagActive = false;
    }
  }

  // Persist all detected events
  for (const e of events) {
    await writeAnomalyToInflux(e);
  }
}
