/**
 * Background ping for the public Monad RPC catalog.
 *
 * Loads `data/monad-rpcs.json` once, then every PING_INTERVAL_MS pings each
 * endpoint with a single `eth_blockNumber` JSON-RPC call. Records latency,
 * tip block, and online/offline status in globalThis. /api/tools/rpcs reads
 * the snapshot.
 *
 * Why we don't hit triedb_env: these are external RPCs we don't operate;
 * one HTTP request per endpoint per minute is a rounding error for any of
 * them. Total outbound rate at steady state: ~20 endpoints / 60s = 0.33/s.
 */

import rpcCatalog from '@/data/monad-rpcs.json';

const PING_INTERVAL_MS = 60_000;     // every minute
const REQUEST_TIMEOUT_MS = 6_000;
const HISTORY_SIZE = 5;              // keep last 5 latency samples for median

export type RpcEntry = {
  network: 'mainnet' | 'testnet' | 'devnet';
  provider: string;
  http: string;
  ws: string | null;
  notes: string;
};

interface RpcStatus {
  http: string;
  status: 'online' | 'offline' | 'unknown';
  latencyMs: number | null;        // most recent
  medianLatencyMs: number | null;  // median of last HISTORY_SIZE pings
  tipBlock: number | null;
  lastError: string | null;
  lastCheckedAt: number;
  history: number[];               // last N latencies (failed = -1)
}

interface MonitorState {
  byHttp: Map<string, RpcStatus>;
  lastFullScanAt: number;
  scanCount: number;
}

const g = globalThis as unknown as { __monadRpcMonitor__?: MonitorState };
if (!g.__monadRpcMonitor__) {
  g.__monadRpcMonitor__ = { byHttp: new Map(), lastFullScanAt: 0, scanCount: 0 };
}
const S = g.__monadRpcMonitor__!;

async function pingOne(http: string): Promise<{ latencyMs: number; tipBlock: number | null; error: string | null }> {
  const t0 = Date.now();
  try {
    const res = await fetch(http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { latencyMs, tipBlock: null, error: `HTTP ${res.status}` };
    }
    const j = await res.json() as { result?: string; error?: { message?: string } };
    if (j.error) return { latencyMs, tipBlock: null, error: j.error.message ?? 'rpc error' };
    if (!j.result) return { latencyMs, tipBlock: null, error: 'no result' };
    const tipBlock = parseInt(j.result, 16);
    return { latencyMs, tipBlock, error: null };
  } catch (e) {
    return {
      latencyMs: Date.now() - t0,
      tipBlock: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function tickRpcMonitor(): Promise<void> {
  const entries = (rpcCatalog as { rpcs: RpcEntry[] }).rpcs;
  // Fan out — each ping is to a different host so concurrency is fine.
  const results = await Promise.allSettled(
    entries.map(async e => ({ entry: e, result: await pingOne(e.http) }))
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { entry, result } = r.value;
    const prev = S.byHttp.get(entry.http);
    const history = prev?.history ?? [];
    history.push(result.error ? -1 : result.latencyMs);
    while (history.length > HISTORY_SIZE) history.shift();
    const okSamples = history.filter(x => x >= 0).sort((a, b) => a - b);
    const medianLatencyMs = okSamples.length === 0
      ? null
      : okSamples[Math.floor(okSamples.length / 2)];
    S.byHttp.set(entry.http, {
      http: entry.http,
      status: result.error ? 'offline' : 'online',
      latencyMs: result.error ? null : result.latencyMs,
      medianLatencyMs,
      tipBlock: result.tipBlock,
      lastError: result.error,
      lastCheckedAt: Date.now(),
      history,
    });
  }
  S.lastFullScanAt = Date.now();
  S.scanCount++;
}

export function getRpcSnapshot(): {
  catalog: typeof rpcCatalog;
  status: RpcStatus[];
  lastFullScanAt: number;
  scanCount: number;
} {
  return {
    catalog: rpcCatalog,
    status: Array.from(S.byHttp.values()),
    lastFullScanAt: S.lastFullScanAt,
    scanCount: S.scanCount,
  };
}

export const RPC_PING_INTERVAL_MS = PING_INTERVAL_MS;
