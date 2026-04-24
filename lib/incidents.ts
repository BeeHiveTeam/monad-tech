/**
 * Unified incident timeline — aggregates anomalies from multiple sources into
 * a single chronological feed.
 *
 * Sources:
 *   - Reorgs           → networkHealth (in-memory, since service start)
 *   - Validator churn  → networkHealth (in-memory, since service start)
 *   - Retry spikes     → Loki exec_block logs (up to 7d retention)
 *   - Block stalls     → Loki exec_block logs (gap detection between consecutive blocks)
 *   - Critical logs    → Loki ERROR/FATAL from monad-execution & monad-bft
 *
 * Each detector returns `Incident[]` independently and we merge+sort in the API.
 * Severity mapping:
 *   critical = requires operator attention (consensus bugs, panics, removals)
 *   warn     = notable event worth investigating (deep reorgs, stake drops, stalls)
 *   info     = transient or routine (new validator joined)
 */

import { fetchExecStats, fetchExecStatsFromInflux, ExecStat } from './execStats';
import {
  getReorgState, getSetChanges,
  fetchReorgsFromInflux, fetchSetChangesFromInflux,
} from './networkHealth';

const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';

export type Severity = 'info' | 'warn' | 'critical';
export type IncidentType =
  | 'reorg'
  | 'validator_removed' | 'validator_added' | 'stake_decrease'
  | 'retry_spike' | 'block_stall'
  | 'critical_log';

export interface Incident {
  id: string;              // stable-ish key for React list
  ts: number;              // ms
  severity: Severity;
  type: IncidentType;
  title: string;
  detail: string;
  blockNumber?: number;
  address?: string;
  service?: string;        // for critical_log
  meta?: Record<string, unknown>;
}

// -- Detectors ----------------------------------------------------------------

export async function collectReorgs(sinceMs: number): Promise<Incident[]> {
  // Primary source: InfluxDB persistence (survives restarts).
  // Fallback: in-memory ring (only since last boot) if Influx query fails.
  const windowSec = Math.ceil((Date.now() - sinceMs) / 1000);
  const persisted = await fetchReorgsFromInflux(windowSec);
  const events = persisted ?? getReorgState().events.filter(e => e.ts >= sinceMs);
  return events
    .filter(e => e.ts >= sinceMs)
    .map(e => ({
      id: `reorg-${e.blockNumber}-${e.ts}`,
      ts: e.ts,
      severity: (e.depth >= 2 ? 'critical' : 'warn') as Severity,
      type: 'reorg' as const,
      title: `Reorg at block ${e.blockNumber} · depth ${e.depth}`,
      detail: `Chain rewrite: ${e.oldHash.slice(0, 12)}… → ${e.newHash.slice(0, 12)}…`,
      blockNumber: e.blockNumber,
      meta: { depth: e.depth, oldHash: e.oldHash, newHash: e.newHash },
    }));
}

export async function collectValidatorSetChanges(sinceMs: number): Promise<Incident[]> {
  const windowSec = Math.ceil((Date.now() - sinceMs) / 1000);
  const persisted = await fetchSetChangesFromInflux(windowSec);
  const events = persisted ?? getSetChanges().events.filter(e => e.ts >= sinceMs);
  return events
    .filter(e => e.ts >= sinceMs)
    .map(e => {
      const who = e.moniker ?? `${e.address.slice(0, 10)}…`;
      if (e.type === 'removed') {
        return {
          id: `vsc-rem-${e.address}-${e.ts}`,
          ts: e.ts,
          severity: 'critical' as Severity,
          type: 'validator_removed' as IncidentType,
          title: `Validator removed: ${who}`,
          detail: `No longer in active set. Address ${e.address}.`,
          address: e.address,
          meta: e as unknown as Record<string, unknown>,
        };
      }
      if (e.type === 'added') {
        return {
          id: `vsc-add-${e.address}-${e.ts}`,
          ts: e.ts,
          severity: 'info' as Severity,
          type: 'validator_added' as IncidentType,
          title: `New validator: ${who}`,
          detail: `Joined active set${e.newStake ? ` with ${e.newStake.toLocaleString()} MON` : ''}.`,
          address: e.address,
          meta: e as unknown as Record<string, unknown>,
        };
      }
      // stake_decrease
      const delta = e.delta ?? 0;
      return {
        id: `vsc-dec-${e.address}-${e.ts}`,
        ts: e.ts,
        severity: (Math.abs(delta) >= 100_000 ? 'critical' : 'warn') as Severity,
        type: 'stake_decrease' as IncidentType,
        title: `Stake decrease: ${who} · Δ ${delta.toLocaleString()} MON`,
        detail: `Stake went from ${e.oldStake?.toLocaleString() ?? '?'} to ${e.newStake?.toLocaleString() ?? '?'} MON.`,
        address: e.address,
        meta: e as unknown as Record<string, unknown>,
      };
    });
}

// Loki queries for __exec_block time out on ranges wider than ~15min, so for
// longer windows we query InfluxDB where tickExecWriter has been persisting
// per-block exec stats. Short ranges keep using Loki for freshest data (the
// writer polls every 30s so Influx is ~30s behind).
const LOKI_WINDOW_CAP = 900;

async function getExecStats(rangeSeconds: number): Promise<ExecStat[]> {
  if (rangeSeconds <= LOKI_WINDOW_CAP) {
    return fetchExecStats(rangeSeconds, 5000);
  }
  const fromInflux = await fetchExecStatsFromInflux(rangeSeconds);
  // Fallback: if InfluxDB has no data yet (writer just started or reset),
  // serve whatever the last 15min of Loki has instead of an empty feed.
  if (fromInflux.length === 0) return fetchExecStats(LOKI_WINDOW_CAP, 5000);
  return fromInflux;
}

/**
 * Retry spike = a block with rtp >= 90% AND tx >= 5. Most blocks have some
 * retries so we filter hard to keep signal high. 5+ tx guards against tiny
 * blocks where 3/3 retry looks dramatic but is just 3 tx.
 */
export async function detectRetrySpikes(rangeSeconds: number): Promise<Incident[]> {
  const execs = await getExecStats(rangeSeconds);
  return execs
    .filter(e => e.rtp >= 90 && e.tx >= 5)
    .map(e => ({
      id: `rsp-${e.block}`,
      ts: e.ts,
      severity: 'warn' as Severity,
      type: 'retry_spike' as const,
      title: `Retry spike: block ${e.block} · ${e.rtp.toFixed(1)}%`,
      detail: `${e.rt} of ${e.tx} tx re-executed. Block took ${e.tot}µs total.`,
      blockNumber: e.block,
      meta: { rtp: e.rtp, rt: e.rt, tx: e.tx, tot: e.tot },
    }));
}

/**
 * Block stall = gap between consecutive blocks > 3s. Warn at 3s, critical at 10s.
 * Monad targets ~0.4s block time so 3s = ~7x slower than normal.
 */
export async function detectBlockStalls(rangeSeconds: number): Promise<Incident[]> {
  const execs = await getExecStats(rangeSeconds);
  const out: Incident[] = [];
  for (let i = 1; i < execs.length; i++) {
    const gapMs = execs[i].ts - execs[i - 1].ts;
    if (gapMs < 3000) continue;
    const severity: Severity = gapMs >= 10000 ? 'critical' : 'warn';
    out.push({
      id: `stl-${execs[i].block}`,
      ts: execs[i].ts,
      severity,
      type: 'block_stall' as const,
      title: `Block stall: ${(gapMs / 1000).toFixed(1)}s gap`,
      detail: `Block ${execs[i].block} arrived ${(gapMs / 1000).toFixed(1)}s after block ${execs[i - 1].block}. Normal = ~0.4s.`,
      blockNumber: execs[i].block,
      meta: { gapMs, prevBlock: execs[i - 1].block },
    });
  }
  return out;
}

/**
 * Critical logs — ERROR/FATAL from monad-execution and monad-bft, plus any
 * line mentioning panic/assertion/abort/oom regardless of level. We cap at
 * 50 per range to avoid flooding the UI if there's a log storm.
 */
const LOG_SEVERE_PATTERNS = /panic|assertion|abort|fatal|oom|chunk.?exhaust|bug/i;

export async function detectCriticalLogs(rangeSeconds: number): Promise<Incident[]> {
  const end = Date.now() * 1_000_000;
  const start = end - rangeSeconds * 1e9;
  // Query explicitly for ERROR/FATAL levels on both services. severity_text
  // is set as a label by otelcol via `severity_text_as_label: true`.
  const query =
    '{service_name=~"monad-execution|monad-bft",severity_text=~"ERROR|FATAL"}';
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}`
    + `&start=${Math.floor(start)}&end=${Math.floor(end)}`
    + `&limit=500&direction=backward`;

  let json: { data?: { result?: Array<{
    stream?: Record<string, string>;
    values: Array<[string, string]>;
  }> } };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    if (!r.ok) return [];
    json = await r.json();
  } catch {
    return [];
  }

  const out: Incident[] = [];
  const seen = new Set<string>();
  for (const stream of json.data?.result ?? []) {
    const service = stream.stream?.service_name ?? 'unknown';
    const level = stream.stream?.severity_text ?? '';
    for (const [tsNs, line] of stream.values ?? []) {
      // Extract a short message from the structured MESSAGE field.
      let msg = line;
      try {
        const outer = JSON.parse(line) as { MESSAGE?: string };
        if (outer.MESSAGE) msg = outer.MESSAGE;
      } catch { /* plain text */ }

      // De-duplicate on message prefix (many logs repeat exactly).
      const key = msg.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);

      const tsMs = Math.round(Number(tsNs) / 1_000_000);
      const isVerySevere = level === 'FATAL' || LOG_SEVERE_PATTERNS.test(msg);
      out.push({
        id: `log-${tsNs}`,
        ts: tsMs,
        severity: isVerySevere ? 'critical' : 'warn',
        type: 'critical_log' as const,
        title: `${service} ${level}: ${truncate(msg, 80)}`,
        detail: truncate(msg, 500),
        service,
        meta: { level },
      });
      if (out.length >= 50) break;
    }
    if (out.length >= 50) break;
  }
  return out;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1) + '…';
}

// -- Orchestrator -------------------------------------------------------------

export interface IncidentFeed {
  fetchedAt: number;
  windowSeconds: number;
  counts: Record<Severity, number>;
  byType: Record<IncidentType, number>;
  incidents: Incident[];
}

export async function buildIncidentFeed(
  rangeSeconds: number,
  severityFilter?: Severity,
): Promise<IncidentFeed> {
  const sinceMs = Date.now() - rangeSeconds * 1000;

  const [retries, stalls, logs, reorgs, valset] = await Promise.all([
    detectRetrySpikes(rangeSeconds),
    detectBlockStalls(rangeSeconds),
    detectCriticalLogs(rangeSeconds),
    collectReorgs(sinceMs),
    collectValidatorSetChanges(sinceMs),
  ]);

  let incidents = [...reorgs, ...valset, ...retries, ...stalls, ...logs];
  if (severityFilter) {
    incidents = incidents.filter(i => i.severity === severityFilter);
  }
  incidents.sort((a, b) => b.ts - a.ts);

  const counts: Record<Severity, number> = { info: 0, warn: 0, critical: 0 };
  const byType: Record<IncidentType, number> = {
    reorg: 0, validator_removed: 0, validator_added: 0, stake_decrease: 0,
    retry_spike: 0, block_stall: 0, critical_log: 0,
  };
  for (const i of incidents) {
    counts[i.severity]++;
    byType[i.type]++;
  }

  return {
    fetchedAt: Date.now(),
    windowSeconds: rangeSeconds,
    counts,
    byType,
    incidents: incidents.slice(0, 300),
  };
}

// -- Cache --------------------------------------------------------------------
interface Cache { at: number; data: IncidentFeed }
const cache = new Map<string, Cache>();
const CACHE_TTL_MS = 30_000;

export async function getIncidentFeedCached(
  rangeSeconds: number,
  severityFilter?: Severity,
): Promise<IncidentFeed> {
  const key = `${rangeSeconds}|${severityFilter ?? 'all'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await buildIncidentFeed(rangeSeconds, severityFilter);
  cache.set(key, { at: Date.now(), data });
  return data;
}
