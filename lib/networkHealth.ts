// State for network health metrics. Populated by background pollers registered
// in `instrumentation.ts`; read by `/api/network-health`. State is kept on
// `globalThis` because Next.js may bundle instrumentation.ts and API routes
// into separate webpack chunks — a plain module-level `const` would otherwise
// give each chunk its own copy and readers would see empty data.

const RPC_URL = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';
const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

// ── InfluxDB persistence helpers ─────────────────────────────────────────
// Reorgs and validator-set changes are rare but matter. Historically we kept
// them in-memory only, which meant every PM2 restart wiped the user-visible
// history. Now we dual-write: keep the in-memory ring for fast reads AND
// write to InfluxDB so the incident feed survives restarts.

async function influxWrite(lines: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines,
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* non-critical */ }
}

function influxEscapeTag(v: string): string {
  return v.replace(/[,= ]/g, '_');
}
function influxEscapeStringField(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function writeReorgToInflux(e: ReorgEvent): Promise<void> {
  const line = `monad_reorgs,network=testnet `
    + `block=${e.blockNumber}i,depth=${e.depth}i,`
    + `old_hash="${influxEscapeStringField(e.oldHash)}",`
    + `new_hash="${influxEscapeStringField(e.newHash)}" `
    + `${e.ts}`;
  await influxWrite(line);
}

async function writeSetChangeToInflux(e: SetChangeEvent): Promise<void> {
  const fields: string[] = [`address="${e.address}"`];
  if (e.moniker) fields.push(`moniker="${influxEscapeStringField(e.moniker)}"`);
  if (e.oldStake !== undefined) fields.push(`old_stake=${e.oldStake}`);
  if (e.newStake !== undefined) fields.push(`new_stake=${e.newStake}`);
  if (e.delta !== undefined) fields.push(`delta=${e.delta}`);
  const line = `monad_valset_changes,network=testnet,type=${influxEscapeTag(e.type)} `
    + fields.join(',') + ' ' + e.ts;
  await influxWrite(line);
}

/**
 * Read persisted reorgs from InfluxDB within the last `windowSeconds`.
 * Returns `null` on any query error so callers can fall back to in-memory.
 */
export async function fetchReorgsFromInflux(windowSeconds: number): Promise<ReorgEvent[] | null> {
  try {
    const q = `SELECT block,depth,old_hash,new_hash FROM monad_reorgs `
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
    return s.values.map(row => ({
      ts: Number(row[idx.time]),
      blockNumber: Number(row[idx.block]),
      depth: Number(row[idx.depth]),
      oldHash: String(row[idx.old_hash] ?? ''),
      newHash: String(row[idx.new_hash] ?? ''),
    }));
  } catch { return null; }
}

/**
 * Read persisted validator-set changes from InfluxDB.
 */
export async function fetchSetChangesFromInflux(windowSeconds: number): Promise<SetChangeEvent[] | null> {
  try {
    const q = `SELECT type,address,moniker,old_stake,new_stake,delta FROM monad_valset_changes `
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
      const typeStr = String(row[idx.type] ?? '');
      const validType = (['removed', 'stake_decrease', 'added'] as const).find(t => t === typeStr);
      return {
        ts: Number(row[idx.time]),
        type: (validType ?? 'removed') as SetChangeEvent['type'],
        address: String(row[idx.address] ?? ''),
        moniker: row[idx.moniker] ? String(row[idx.moniker]) : undefined,
        oldStake: row[idx.old_stake] != null ? Number(row[idx.old_stake]) : undefined,
        newStake: row[idx.new_stake] != null ? Number(row[idx.new_stake]) : undefined,
        delta: row[idx.delta] != null ? Number(row[idx.delta]) : undefined,
      };
    });
  } catch { return null; }
}

export interface ReorgEvent {
  ts: number; blockNumber: number; oldHash: string; newHash: string; depth: number;
}
interface BlockRecord { number: number; hash: string; ts: number; }
export interface GeoSummary {
  fetchedAt: number;
  totalPeers: number;
  byCountry: Array<{ country: string; countryCode: string; count: number }>;
  byAsn: Array<{ asn: string; org: string; count: number }>;
  sampleIps: number;
}
export interface SetChangeEvent {
  ts: number;
  type: 'removed' | 'stake_decrease' | 'added';
  address: string; moniker?: string;
  oldStake?: number; newStake?: number; delta?: number;
}
interface ValidatorSnapshot { address: string; moniker?: string; stakeMon: number; }

interface NhStore {
  blockHistory: Map<number, BlockRecord>;
  reorgEvents: ReorgEvent[];
  clientVersion: { value: string; ts: number } | null;
  ipCache: Map<string, { country: string; countryCode: string; asn: string; org: string }>;
  geoSummary: GeoSummary | null;
  prevValidatorSet: Map<string, ValidatorSnapshot> | null;
  setChangeEvents: SetChangeEvent[];
  lastTipNumber: number | null;
}
const g = globalThis as unknown as { __monadNh__?: NhStore };
if (!g.__monadNh__) {
  g.__monadNh__ = {
    blockHistory: new Map(),
    reorgEvents: [],
    clientVersion: null,
    ipCache: new Map(),
    geoSummary: null,
    prevValidatorSet: null,
    setChangeEvents: [],
    lastTipNumber: null,
  };
}
const S = g.__monadNh__!;

const REORG_HISTORY_SIZE = 200;
const BLOCK_HISTORY_KEEP = 500;
// Detector tick is 4s; at 0.4s block time that's ~10 new blocks per tick.
// We backfill all blocks between previous tip and current tip so every block
// has a recorded hash, and re-check the last REORG_DEPTH_CHECK blocks.
// Reduced 30→15 to cut steady eth_getBlockByNumber pressure on monad-rpc
// (was ~1050 methods/min steady, now ~375 — see [[monad-rpc-pacing]]).
const REORG_DEPTH_CHECK = 15;
const REORG_BACKFILL_LIMIT = 50; // safety cap if we fall behind

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`rpc ${method}: ${res.status}`);
  const j = await res.json() as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

interface RpcBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

export async function tickReorgDetector(): Promise<void> {
  try {
    // Tip comes from shared cache — avoids duplicating eth_getBlockByNumber
    // between reorg detector, tps collector, and /api/stats.
    const { getTip } = await import('./tipCache');
    const tip = await getTip();

    // Determine which block numbers need RPC fetch:
    //  1. New blocks since last tick (backfill so we have hashes for them)
    //  2. Last REORG_DEPTH_CHECK blocks for re-comparison (detect reorgs)
    const lastSeen = S.lastTipNumber ?? tip.number - 1;
    const newCount = Math.min(tip.number - lastSeen, REORG_BACKFILL_LIMIT);

    // Backfill range: newest first, capped at REORG_BACKFILL_LIMIT
    const fetchNums = new Set<number>();
    for (let d = 0; d < newCount; d++) fetchNums.add(tip.number - d);
    // Re-check the last N blocks regardless of whether we have them
    for (let d = 1; d <= REORG_DEPTH_CHECK; d++) {
      if (tip.number - d >= 0) fetchNums.add(tip.number - d);
    }

    if (fetchNums.size === 0) return;

    // Single batched HTTP POST for everything we need.
    const nums = [...fetchNums];
    const body = nums.map((n, i) => ({
      jsonrpc: '2.0', id: i,
      method: 'eth_getBlockByNumber',
      params: [`0x${n.toString(16)}`, false] as unknown[],
    }));
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return;
    const j = await res.json() as Array<{ id: number; result?: RpcBlock }>;

    for (const item of j) {
      const n = nums[item.id];
      const blk = item.result;
      if (typeof n !== 'number' || !blk) continue;
      const existing = S.blockHistory.get(n);
      if (!existing) {
        // First time seeing this block → record it (no reorg comparison possible)
        recordBlock(n, blk.hash);
        continue;
      }
      if (blk.hash !== existing.hash) {
        const event: ReorgEvent = {
          ts: Date.now(), blockNumber: n,
          oldHash: existing.hash, newHash: blk.hash, depth: tip.number - n,
        };
        S.reorgEvents.push(event);
        if (S.reorgEvents.length > REORG_HISTORY_SIZE) S.reorgEvents.shift();
        existing.hash = blk.hash;
        writeReorgToInflux(event);    // fire-and-forget persistence
      }
    }

    S.lastTipNumber = tip.number;
  } catch { /* next tick retries */ }
}

function recordBlock(number: number, hash: string) {
  S.blockHistory.set(number, { number, hash, ts: Date.now() });
  if (S.blockHistory.size > BLOCK_HISTORY_KEEP) {
    const keys = [...S.blockHistory.keys()].sort((a, b) => a - b);
    const drop = keys.slice(0, S.blockHistory.size - BLOCK_HISTORY_KEEP);
    for (const k of drop) S.blockHistory.delete(k);
  }
}

export function getReorgState() {
  return {
    events: S.reorgEvents.slice(-50),
    totalDetected: S.reorgEvents.length,
    trackedBlocks: S.blockHistory.size,
    windowStart: S.reorgEvents[0]?.ts ?? null,
  };
}

// ─── Client version tracking ───────────────────────────────────────
// We can only observe the RPC server's version. We don't have a way to
// enumerate per-validator versions from a public endpoint, so this is
// a network-wide signal (RPC = whatever version the public gateway is on).

export async function getClientVersion(): Promise<{
  rpc: string | null;          // Public RPC gateway's reported version (may differ from our node)
  installed: string | null;    // OUR validator's actually running version (from otelcol metric label)
  fetchedAt: number | null;
  latest: string | null;       // Latest release on GitHub
  latestUrl: string | null;
  latestFetchedAt: number | null;
  isUpToDate: boolean | null;  // installed >= latest
  rpcMatchesInstalled: boolean | null;
}> {
  if (!S.clientVersion || Date.now() - S.clientVersion.ts > 5 * 60_000) {
    try {
      const v = await rpc<string>('web3_clientVersion');
      S.clientVersion = { value: v, ts: Date.now() };
    } catch { /* keep cached value */ }
  }
  const rpcVer = S.clientVersion?.value ?? null;

  const installed = await getInstalledVersion();
  const latest = await getLatestMonadRelease();

  // Compare semver loosely: strip "Monad/" prefix and "v", compare by tuple.
  // Truth for "up to date" is INSTALLED version (on our validator), not RPC.
  const stripPrefix = (s: string | null) => s ? s.replace(/^Monad\//, '').replace(/^v/, '') : null;
  const installedSemver = stripPrefix(installed);
  const rpcSemver       = stripPrefix(rpcVer);
  const latestSemver    = latest?.tag ? latest.tag.replace(/^v/, '') : null;

  let isUpToDate: boolean | null = null;
  if (installedSemver && latestSemver) {
    isUpToDate = compareSemver(installedSemver, latestSemver) >= 0;
  } else if (rpcSemver && latestSemver) {
    isUpToDate = compareSemver(rpcSemver, latestSemver) >= 0;
  }

  let rpcMatchesInstalled: boolean | null = null;
  if (installedSemver && rpcSemver) {
    rpcMatchesInstalled = installedSemver === rpcSemver;
  }

  return {
    rpc: rpcVer,
    installed,
    fetchedAt: S.clientVersion?.ts ?? null,
    latest: latest?.tag ?? null,
    latestUrl: latest?.url ?? null,
    latestFetchedAt: latest?.fetchedAt ?? null,
    isUpToDate,
    rpcMatchesInstalled,
  };
}

// Scrape `service_version` from our validator's otelcol Prometheus endpoint.
// Every Monad metric is tagged with this label — it reflects the actually
// running binary, not whatever the public RPC gateway is on.
const OTELCOL_METRICS = process.env.MONAD_METRICS_URL || 'http://15.235.117.52:8889/metrics';

async function getInstalledVersion(): Promise<string | null> {
  interface Cache { ver: string | null; ts: number }
  const gCache = globalThis as unknown as { __installedVer__?: Cache };
  const c = gCache.__installedVer__;
  if (c && Date.now() - c.ts < 60_000) return c.ver;
  try {
    const res = await fetch(OTELCOL_METRICS, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return c?.ver ?? null;
    const text = await res.text();
    // Labels like:  monad_..._xxx{...service_version="0.14.1",...} value
    const m = text.match(/service_version="([^"]+)"/);
    const ver = m ? m[1] : null;
    gCache.__installedVer__ = { ver, ts: Date.now() };
    return ver;
  } catch {
    return c?.ver ?? null;
  }
}

// Public repo with Monad node sources. Confirmed working 2026-04-22.
const MONAD_RELEASES_REPO = process.env.MONAD_RELEASES_REPO || 'category-labs/monad-bft';

async function getLatestMonadRelease(): Promise<{ tag: string; url: string; fetchedAt: number } | null> {
  // Cache aggressively — GitHub has a 60 req/hour unauthenticated rate limit,
  // and releases don't change more than once per week.
  interface CacheEntry { tag: string; url: string; fetchedAt: number }
  const gCache = globalThis as unknown as { __monadRelease__?: CacheEntry };
  const e = gCache.__monadRelease__;
  if (e && Date.now() - e.fetchedAt < 60 * 60_000) return e;
  try {
    const res = await fetch(`https://api.github.com/repos/${MONAD_RELEASES_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return e ?? null;
    const j = await res.json() as { tag_name?: string; html_url?: string };
    if (!j.tag_name) return e ?? null;
    const fresh = { tag: j.tag_name, url: j.html_url ?? '', fetchedAt: Date.now() };
    gCache.__monadRelease__ = fresh;
    return fresh;
  } catch {
    return e ?? null;
  }
}

// Compare two dotted numeric version strings. Returns -1, 0, 1.
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ─── Peer geo-distribution ─────────────────────────────────────────
// Pull peer IPs from journald keepalive logs, geolocate via free ip-api.com.

async function extractPeerIps(): Promise<string[]> {
  // 15m window is enough — monad-bft emits keepalives every few seconds per
  // peer, so we'll see the full mesh in minutes. Longer windows stress Loki's
  // filesystem backend and blow past our timeout.
  const MS_TO_NS = BigInt(1_000_000);
  const endNs = BigInt(Date.now()) * MS_TO_NS;
  const startNs = endNs - BigInt(900) * BigInt(1_000_000_000);
  const query = '{service_name="monad-bft"} |~ `remote_addr`';
  const url = `${LOKI_URL}/loki/api/v1/query_range` +
    `?query=${encodeURIComponent(query)}` +
    `&start=${startNs}&end=${endNs}&limit=1500&direction=backward`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.log(`[geo] Loki fetch failed: ${res.status}`);
    return [];
  }
  const j = await res.json() as {
    data?: { result?: Array<{ values?: Array<[string, string]> }> };
  };
  const streams = j.data?.result ?? [];
  const totalLines = streams.reduce((n, s) => n + (s.values?.length ?? 0), 0);
  // eslint-disable-next-line no-console
  console.log(`[geo] Loki returned ${streams.length} streams, ${totalLines} lines`);
  const ips = new Set<string>();
  // Matches any occurrence `remote_addr` followed by IP, tolerant of quoting
  const rx = /remote_addr[^0-9]{0,6}(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+/g;
  for (const s of streams) {
    for (const [, line] of s.values ?? []) {
      let m; while ((m = rx.exec(line)) !== null) ips.add(m[1]);
    }
  }
  return [...ips];
}

async function geolocateBatch(ips: string[]): Promise<void> {
  const uncached = ips.filter(ip => !S.ipCache.has(ip)).slice(0, 100);
  if (uncached.length === 0) return;
  try {
    const res = await fetch('http://ip-api.com/batch?fields=status,country,countryCode,as,org,query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uncached),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const j = await res.json() as Array<{
      status: string; query: string; country?: string; countryCode?: string;
      as?: string; org?: string;
    }>;
    for (const r of j) {
      if (r.status === 'success') {
        S.ipCache.set(r.query, {
          country: r.country ?? 'Unknown',
          countryCode: r.countryCode ?? '??',
          asn: r.as?.split(' ')[0] ?? '',
          org: r.org ?? '',
        });
      }
    }
  } catch { /* swallow */ }
}

export async function refreshGeoDistribution(): Promise<void> {
  try {
    // eslint-disable-next-line no-console
    console.log(`[geo] refresh start, LOKI_URL=${LOKI_URL}`);
    const ips = await extractPeerIps();
    // eslint-disable-next-line no-console
    console.log(`[geo] extracted ${ips.length} peer IPs from Loki`);
    if (ips.length === 0) return;
    await geolocateBatch(ips);
    // eslint-disable-next-line no-console
    console.log(`[geo] geolocation complete, ipCache size=${S.ipCache.size}`);

    const byCountry = new Map<string, { country: string; countryCode: string; count: number }>();
    const byAsn = new Map<string, { asn: string; org: string; count: number }>();
    for (const ip of ips) {
      const info = S.ipCache.get(ip);
      if (!info) continue;
      const ce = byCountry.get(info.countryCode) ?? { country: info.country, countryCode: info.countryCode, count: 0 };
      ce.count++;
      byCountry.set(info.countryCode, ce);
      if (info.asn) {
        const ae = byAsn.get(info.asn) ?? { asn: info.asn, org: info.org, count: 0 };
        ae.count++;
        byAsn.set(info.asn, ae);
      }
    }
    S.geoSummary = {
      fetchedAt: Date.now(),
      totalPeers: ips.length,
      byCountry: [...byCountry.values()].sort((a, b) => b.count - a.count),
      byAsn: [...byAsn.values()].sort((a, b) => b.count - a.count).slice(0, 15),
      sampleIps: S.ipCache.size,
    };
    // eslint-disable-next-line no-console
    console.log(`[geo] summary built: countries=${S.geoSummary.byCountry.length} asns=${S.geoSummary.byAsn.length}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[geo] refresh error: ${e}`);
  }
}

export function getGeoSummary(): GeoSummary | null {
  return S.geoSummary;
}

// ─── Validator set change tracking (slashing placeholder) ──────────
// Since Monad testnet doesn't expose slashing events via RPC, we track
// validator set membership and stake across polls. Any drop/removal is
// surfaced as a "set change event". True slashings would show as sharp
// stake decreases.

const SET_CHANGE_HISTORY = 200;
const STAKE_DROP_THRESHOLD = 1000;   // MON — ignore jitter below this

export async function tickValidatorSetTracker(): Promise<void> {
  try {
    const base = process.env.SELF_URL ?? 'http://127.0.0.1:3001';
    const res = await fetch(`${base}/api/validators`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return;
    const body = await res.json() as
      | Array<{ address: string; moniker?: string; stakeMon?: number }>
      | { validators?: Array<{ address: string; moniker?: string; stakeMon?: number }>; building?: boolean };
    const arr = Array.isArray(body) ? body : (body.validators ?? []);
    // If the validator registry is still warming up (returns 0), skip this
    // tick — overwriting prev with an empty set would emit spurious "added"
    // events on the next real poll.
    if (arr.length === 0) return;
    const curr = new Map<string, ValidatorSnapshot>();
    for (const v of arr) {
      curr.set(v.address.toLowerCase(), {
        address: v.address.toLowerCase(),
        moniker: v.moniker,
        stakeMon: Number(v.stakeMon ?? 0),
      });
    }
    // Skip comparison until we have a populated baseline. Seed-only tick.
    if (S.prevValidatorSet && S.prevValidatorSet.size > 0) {
      for (const [addr, prev] of S.prevValidatorSet) {
        const now = curr.get(addr);
        if (!now) {
          push({ ts: Date.now(), type: 'removed', address: addr, moniker: prev.moniker, oldStake: prev.stakeMon });
        } else if (now.stakeMon < prev.stakeMon - STAKE_DROP_THRESHOLD) {
          push({
            ts: Date.now(), type: 'stake_decrease',
            address: addr, moniker: now.moniker,
            oldStake: prev.stakeMon, newStake: now.stakeMon,
            delta: now.stakeMon - prev.stakeMon,
          });
        }
      }
      for (const [addr, now] of curr) {
        if (!S.prevValidatorSet.has(addr)) {
          push({ ts: Date.now(), type: 'added', address: addr, moniker: now.moniker, newStake: now.stakeMon });
        }
      }
    }
    S.prevValidatorSet = curr;
  } catch { /* swallow */ }
}

function push(e: SetChangeEvent) {
  S.setChangeEvents.push(e);
  if (S.setChangeEvents.length > SET_CHANGE_HISTORY) S.setChangeEvents.shift();
  writeSetChangeToInflux(e);         // fire-and-forget persistence
}

export function getSetChanges() {
  return {
    events: S.setChangeEvents.slice().reverse(),
    tracked: S.prevValidatorSet?.size ?? 0,
  };
}
