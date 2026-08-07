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
// A client version changes on the order of weeks. Re-asking every minute would double the
// request rate against other people's public endpoints to learn something that is static.
const VERSION_REFRESH_MS = 60 * 60_000;

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
  clientVersion: string | null;    // raw web3_clientVersion, e.g. "Monad/0.16.0"
  monadVersion: string | null;     // parsed x.y.z, null when the endpoint is not a Monad node
  versionCheckedAt: number | null;
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

/**
 * Ask an endpoint what it is running.
 *
 * Deliberately separate from the latency ping and run rarely: a version changes on the order
 * of weeks, these are other people's public endpoints, and doubling the request rate to learn
 * something static would be rude.
 */
async function fetchClientVersion(http: string): Promise<string | null> {
  try {
    const res = await fetch(http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: string };
    return typeof j.result === 'string' ? j.result : null;
  } catch {
    return null;
  }
}

/**
 * Pull x.y.z out of a client string, but ONLY for a real Monad node.
 *
 * Several catalogued endpoints are gateways, not nodes: dRPC answers "Geth/v10.0.0/drpc",
 * Tenderly "Tenderly/1.0", thirdweb "thirdweb/1.0". Counting those as "an old Monad version"
 * would invent a problem that does not exist, so they parse to null and are reported as
 * proxies instead of being folded into the histogram.
 */
export function parseMonadVersion(clientVersion: string | null): string | null {
  if (!clientVersion) return null;
  const m = /^Monad\/v?(\d+\.\d+\.\d+)/i.exec(clientVersion.trim());
  return m ? m[1] : null;
}

export async function tickRpcMonitor(): Promise<void> {
  const entries = (rpcCatalog as { rpcs: RpcEntry[] }).rpcs;
  // Fan out — each ping is to a different host so concurrency is fine.
  // Re-ask for the version on the first scan and then roughly once an hour, not every tick.
  const now = Date.now();
  const results = await Promise.allSettled(
    entries.map(async e => {
      const prev = S.byHttp.get(e.http);
      const stale = !prev?.versionCheckedAt || now - prev.versionCheckedAt > VERSION_REFRESH_MS;
      const [result, clientVersion] = await Promise.all([
        pingOne(e.http),
        stale ? fetchClientVersion(e.http) : Promise.resolve(prev?.clientVersion ?? null),
      ]);
      return { entry: e, result, clientVersion, versionRefreshed: stale };
    })
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { entry, result, clientVersion, versionRefreshed } = r.value;
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
      clientVersion,
      monadVersion: parseMonadVersion(clientVersion),
      // Keep the old stamp when we did not re-ask, so the refresh cadence stays honest.
      versionCheckedAt: versionRefreshed ? Date.now() : (prev?.versionCheckedAt ?? null),
    });
  }
  S.lastFullScanAt = Date.now();
  S.scanCount++;
}

export type VersionHistogram = {
  network: string;
  /** Version -> how many Monad endpoints report it, highest version first. */
  counts: { version: string; count: number; providers: string[] }[];
  /** Endpoints that answered but are gateways, not Monad nodes. Not a version problem. */
  proxies: { provider: string; clientVersion: string }[];
  /** Endpoints that did not answer at all. Reported, not silently dropped. */
  unknown: string[];
  monadEndpoints: number;
};

/**
 * Version spread across the PUBLIC RPC ENDPOINTS in the catalog.
 *
 * This is deliberately NOT "versions across the network": a node's version is not published
 * in peer discovery or in a name record, so nothing here can see what validators run. What it
 * can see is what the public gateways answer, which is a real and otherwise unpublished signal
 * — especially in the days around a hardfork, when the interesting question is how much of the
 * reachable surface has actually upgraded. Label it as endpoints, not as nodes.
 */
export function getVersionHistograms(): VersionHistogram[] {
  const entries = (rpcCatalog as { rpcs: RpcEntry[] }).rpcs;
  const byNetwork = new Map<string, VersionHistogram>();

  for (const e of entries) {
    const st = S.byHttp.get(e.http);
    let h = byNetwork.get(e.network);
    if (!h) {
      h = { network: e.network, counts: [], proxies: [], unknown: [], monadEndpoints: 0 };
      byNetwork.set(e.network, h);
    }
    if (!st || st.clientVersion === null) { h.unknown.push(e.provider); continue; }
    if (st.monadVersion === null) { h.proxies.push({ provider: e.provider, clientVersion: st.clientVersion }); continue; }
    h.monadEndpoints++;
    const row = h.counts.find(c => c.version === st.monadVersion);
    if (row) { row.count++; row.providers.push(e.provider); }
    else h.counts.push({ version: st.monadVersion, count: 1, providers: [e.provider] });
  }

  // Newest first, so "how much is still behind" reads down the list.
  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  };
  for (const h of byNetwork.values()) h.counts.sort((a, b) => cmp(a.version, b.version));
  return Array.from(byNetwork.values());
}

export function getRpcSnapshot(): {
  catalog: typeof rpcCatalog;
  status: RpcStatus[];
  versions: VersionHistogram[];
  lastFullScanAt: number;
  scanCount: number;
} {
  return {
    catalog: rpcCatalog,
    status: Array.from(S.byHttp.values()),
    versions: getVersionHistograms(),
    lastFullScanAt: S.lastFullScanAt,
    scanCount: S.scanCount,
  };
}

export const RPC_PING_INTERVAL_MS = PING_INTERVAL_MS;
