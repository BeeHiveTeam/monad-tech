// Per-second TPS timeline — fed by a background block collector in
// instrumentation.ts. Each entry in the ring buffer = transaction count for
// that exact unix second (summing multiple blocks if Monad produced several
// blocks within the same second, which happens at ~0.4s block time).

const RPC_URL = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
const BUCKET_RETENTION_SEC = 86400;  // keep last 24h — supports all chart ranges
// Cap catch-up batches low (10, not 50). When the event loop is blocked by
// other pollers (e.g. /api/validators 5000-block refresh) this collector can
// skip ticks and then try to fetch 20-50 blocks in one burst. At monad-rpc
// that burst is ~100×N internal channel sends → triedb_env overflow → WARN
// storm. With cap 10 we accept minor TPS-chart data loss during overloads.
const MAX_BLOCKS_PER_TICK = 10;

interface TpsStore {
  buckets: Map<number, number>;       // unix second → tx count
  lastSeenBlock: number;              // highest block number consumed
  lastTickTs: number;                 // ms of last successful tick
}

const g = globalThis as unknown as { __monadTps__?: TpsStore };
if (!g.__monadTps__) {
  g.__monadTps__ = { buckets: new Map(), lastSeenBlock: 0, lastTickTs: 0 };
}
const S = g.__monadTps__!;

interface RpcBlock { number: string; timestamp: string; transactions: string[] }

async function rpcBatch(requests: Array<{ method: string; params: unknown[] }>): Promise<unknown[]> {
  const body = requests.map((r, i) => ({ jsonrpc: '2.0', id: i, method: r.method, params: r.params }));
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`rpc batch ${res.status}`);
  const arr = await res.json() as Array<{ id: number; result?: unknown }>;
  const sorted = new Array(requests.length);
  for (const it of arr) {
    if (typeof it.id === 'number') sorted[it.id] = it.result ?? null;
  }
  return sorted;
}

async function rpcSingle(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`rpc ${method}: ${res.status}`);
  const j = await res.json() as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function prune() {
  // Drop buckets older than retention window.
  const cutoff = Math.floor(Date.now() / 1000) - BUCKET_RETENTION_SEC;
  for (const k of S.buckets.keys()) {
    if (k < cutoff) S.buckets.delete(k);
  }
}

export async function tickTpsCollector(): Promise<void> {
  try {
    // Tip comes from shared 500ms cache — dedup with reorg detector + /api/stats.
    const { getTipNumber } = await import('./tipCache');
    const current = await getTipNumber();
    if (!Number.isFinite(current) || current <= 0) return;

    // First tick seeds lastSeenBlock without emitting anything.
    if (S.lastSeenBlock === 0) {
      S.lastSeenBlock = current;
      S.lastTickTs = Date.now();
      return;
    }

    if (current <= S.lastSeenBlock) return;   // no new blocks

    // Fetch all new blocks since lastSeen, capped to avoid flooding RPC if we
    // fell behind (e.g. process was paused). If gap is too large, snap forward
    // and skip (we don't have historical density to reconstruct anyway).
    let fromNum = S.lastSeenBlock + 1;
    const toNum = current;
    if (toNum - fromNum + 1 > MAX_BLOCKS_PER_TICK) {
      fromNum = toNum - MAX_BLOCKS_PER_TICK + 1;   // fetch most recent window only
    }

    const requests = [];
    for (let n = fromNum; n <= toNum; n++) {
      requests.push({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] });
    }
    if (requests.length === 0) return;

    const blocks = (await rpcBatch(requests)) as Array<RpcBlock | null>;
    for (const b of blocks) {
      if (!b || !b.timestamp) continue;
      const ts = parseInt(b.timestamp, 16);
      const txCount = Array.isArray(b.transactions) ? b.transactions.length : 0;
      S.buckets.set(ts, (S.buckets.get(ts) ?? 0) + txCount);
    }

    S.lastSeenBlock = current;
    S.lastTickTs = Date.now();
    prune();
  } catch { /* swallow; next tick retries */ }
}

export interface TpsPoint { ts: number; tps: number; bucketSec: number }

// Returns up to `targetBars` buckets spanning the last `seconds`.
// Each bucket's `tps` = average tx/s over the bucket window (sum / bucketSec).
// For seconds <= targetBars, bucketSec=1 and we return `seconds` bars (not 600) —
// block timestamps are integer seconds so sub-second resolution isn't available.
export function getTpsTimeline(seconds: number, targetBars = 600): TpsPoint[] {
  const now = Math.floor(Date.now() / 1000);
  const bucketSec = Math.max(1, Math.ceil(seconds / targetBars));
  const numBars = Math.ceil(seconds / bucketSec);
  // Align bucket boundaries to `now` (rightmost bucket is partial if not aligned)
  const out: TpsPoint[] = [];
  for (let i = numBars - 1; i >= 0; i--) {
    const rightTs = now - i * bucketSec;        // inclusive right edge
    const leftTs  = rightTs - bucketSec + 1;    // inclusive left edge
    let sum = 0;
    for (let t = leftTs; t <= rightTs; t++) sum += S.buckets.get(t) ?? 0;
    // TPS per bucket = txs / bucket_width_seconds (so value is comparable across ranges)
    out.push({ ts: rightTs, tps: sum / bucketSec, bucketSec });
  }
  return out;
}

export function getTpsCollectorState() {
  return {
    lastSeenBlock: S.lastSeenBlock,
    lastTickTs: S.lastTickTs,
    bucketCount: S.buckets.size,
  };
}
