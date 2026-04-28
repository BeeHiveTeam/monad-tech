/**
 * WebSocket-driven block ring buffer.
 *
 * Architecture:
 *   monad-rpc :8081 ws  →  eth_subscribe("newHeads")  →  push every ~0.4s
 *                                                        ↓
 *                                               header in ring buffer
 *                                                        ↓
 *                                  one eth_getBlockByNumber(num, false)
 *                                  fired async to add txCount + tx hashes
 *                                                        ↓
 *                                  /api/blocks, /api/stats, /api/transactions
 *                                  read directly from ring (zero RPC at request time)
 *
 * This replaces the polling architecture that produced burst loads on
 * monad-rpc's triedb_env channel (see [[rpc-warn-storm-2026-04-26]]).
 *
 * State lives on globalThis because Next.js may bundle into separate webpack
 * chunks — a plain module-level Map would otherwise give each chunk its own
 * copy and readers would see empty data.
 */

import WebSocket from 'ws';

// ── Config ────────────────────────────────────────────────────────────────
const WS_URL = process.env.MONAD_WS_URL ?? 'ws://15.235.117.52:8081';
const HTTP_RPC = process.env.MONAD_RPC_URL ?? 'http://15.235.117.52:8080';
const INFLUX_URL = process.env.INFLUX_URL ?? 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB ?? 'monad';
const RING_SIZE = 1000;        // ~6.5min @ 0.4s block time
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_BACKOFF = 1.5;
const AGGREGATE_WRITE_INTERVAL_MS = 5 * 60_000;  // every 5 min

// ── Types ─────────────────────────────────────────────────────────────────
export interface RingTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;        // hex wei
  gasPrice: string;     // hex wei
  blockNumber: number;
}
export interface RingBlock {
  number: number;
  hash: string;
  parentHash: string;
  miner: string;
  timestamp: number;       // unix sec
  gasUsed: number;
  gasLimit: number;
  size: number;
  baseFeePerGas: number | null;
  txCount: number | null;       // null until enriched
  txs: RingTx[] | null;         // null until enriched (full transaction data)
  receivedAt: number;           // ms — when WS push arrived
  enrichedAt: number | null;    // ms — when txs were filled in (null = pending)
}

interface NewHeadPush {
  number: string;
  hash: string;
  parentHash: string;
  miner: string;
  timestamp: string;
  gasUsed: string;
  gasLimit: string;
  size: string;
  baseFeePerGas?: string;
}

/**
 * Per-miner cumulative aggregate, updated from every WS push.
 * Survives ring eviction (ring keeps only last 1000 blocks; aggregate
 * accumulates indefinitely from process start). On hours of runtime
 * this gives a low-variance window for participation calculations
 * vs the 200s sample window used previously.
 */
export interface MinerAggregate {
  miner: string;             // lowercase 0x address
  blocks: number;
  txs: number;
  firstSeenBlock: number;
  firstSeenTs: number;
  lastSeenBlock: number;
  lastSeenTs: number;
}

interface State {
  ws: WebSocket | null;
  ring: Map<number, RingBlock>;
  subscriptionId: string | null;
  connected: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pushCount: number;
  enrichedCount: number;
  enrichErrors: number;
  lastPushAt: number | null;
  lastError: string | null;
  startedAt: number;
  // Cumulative miner aggregate — updated from every push.
  minerAggregate: Map<string, MinerAggregate>;
  totalBlocksObserved: number;
  totalTxsObserved: number;
  aggregateStartedAt: number;
  aggregateFirstBlock: number | null;
}

const g = globalThis as unknown as { __monadWsStream__?: State };
if (!g.__monadWsStream__) {
  g.__monadWsStream__ = {
    ws: null,
    ring: new Map(),
    subscriptionId: null,
    connected: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    pushCount: 0,
    enrichedCount: 0,
    enrichErrors: 0,
    lastPushAt: null,
    lastError: null,
    startedAt: Date.now(),
    minerAggregate: new Map(),
    totalBlocksObserved: 0,
    totalTxsObserved: 0,
    aggregateStartedAt: Date.now(),
    aggregateFirstBlock: null,
  };
}
const S = g.__monadWsStream__!;

// ── Ring helpers ──────────────────────────────────────────────────────────
function evictOldest() {
  if (S.ring.size <= RING_SIZE) return;
  const keys = [...S.ring.keys()].sort((a, b) => a - b);
  const drop = keys.slice(0, S.ring.size - RING_SIZE);
  for (const k of drop) S.ring.delete(k);
}

function addHeader(h: NewHeadPush): RingBlock {
  const num = parseInt(h.number, 16);
  const ts = parseInt(h.timestamp, 16);
  const block: RingBlock = {
    number: num,
    hash: h.hash,
    parentHash: h.parentHash,
    miner: h.miner,
    timestamp: ts,
    gasUsed: parseInt(h.gasUsed, 16),
    gasLimit: parseInt(h.gasLimit, 16),
    size: parseInt(h.size, 16),
    baseFeePerGas: h.baseFeePerGas ? parseInt(h.baseFeePerGas, 16) : null,
    txCount: null,
    txs: null,
    receivedAt: Date.now(),
    enrichedAt: null,
  };
  S.ring.set(num, block);
  evictOldest();

  // Update cumulative miner aggregate. Indefinite window (since process
  // start). Stable for participation calculations after ~30 min of runtime.
  const miner = h.miner.toLowerCase();
  const agg = S.minerAggregate.get(miner) ?? {
    miner,
    blocks: 0,
    txs: 0,
    firstSeenBlock: num,
    firstSeenTs: ts,
    lastSeenBlock: num,
    lastSeenTs: ts,
  };
  agg.blocks++;
  if (num > agg.lastSeenBlock) {
    agg.lastSeenBlock = num;
    agg.lastSeenTs = ts;
  }
  if (num < agg.firstSeenBlock) {
    agg.firstSeenBlock = num;
    agg.firstSeenTs = ts;
  }
  S.minerAggregate.set(miner, agg);
  S.totalBlocksObserved++;
  if (S.aggregateFirstBlock === null || num < S.aggregateFirstBlock) {
    S.aggregateFirstBlock = num;
  }

  return block;
}

// ── Background enrichment: fetch full tx data via single eth_getBlockByNumber ──
// Per push (~2.5/sec) we fire one full=true call. Smoothly paced — no batching,
// no burst, even at 2.5 calls/sec the triedb_env channel handles it cleanly.
// Cost is heavier per call (full tx data) but rate compensates.
interface RpcTx {
  hash: string; from: string; to: string | null;
  value: string; gasPrice?: string; effectiveGasPrice?: string;
  blockNumber: string;
}
async function enrichBlock(num: number): Promise<void> {
  try {
    const res = await fetch(HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: num,
        method: 'eth_getBlockByNumber',
        params: [`0x${num.toString(16)}`, true],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      S.enrichErrors++;
      return;
    }
    const j = await res.json() as { result?: { transactions?: RpcTx[] } };
    const rawTxs = j.result?.transactions ?? [];
    const block = S.ring.get(num);
    if (!block) return; // evicted while we were fetching
    block.txCount = rawTxs.length;
    block.txs = rawTxs.map(t => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      value: t.value || '0x0',
      gasPrice: t.gasPrice || t.effectiveGasPrice || '0x0',
      blockNumber: parseInt(t.blockNumber, 16),
    }));
    block.enrichedAt = Date.now();
    S.enrichedCount++;

    // Update miner aggregate with tx count. Header-side already incremented
    // block count; here we add the tx count once we know it.
    const miner = block.miner.toLowerCase();
    const agg = S.minerAggregate.get(miner);
    if (agg) {
      agg.txs += rawTxs.length;
    }
    S.totalTxsObserved += rawTxs.length;
  } catch {
    S.enrichErrors++;
  }
}

// ── InfluxDB persistence for the miner aggregate ──────────────────────────
// Writes ALL miners as a single InfluxDB batch every 5 min. On startup we
// hydrate from the latest write so participationLong stays meaningful across
// PM2 restarts. No RPC overhead — InfluxDB is on the same host as dashboard.

function escapeStr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function writeAggregateSnapshot(): Promise<void> {
  if (S.minerAggregate.size === 0) return;
  const ts = Date.now();
  const lines: string[] = [];
  for (const a of S.minerAggregate.values()) {
    // miner as tag (low cardinality, ~200-300 unique addresses)
    lines.push(
      `monad_validator_aggregate,network=testnet,miner=${a.miner} ` +
      `blocks=${a.blocks}i,txs=${a.txs}i,` +
      `first_block=${a.firstSeenBlock}i,first_ts=${a.firstSeenTs}i,` +
      `last_block=${a.lastSeenBlock}i,last_ts=${a.lastSeenTs}i ` +
      `${ts}`
    );
  }
  // Append our own start metadata so we can restore aggregateFirstBlock too.
  lines.push(
    `monad_validator_aggregate_meta,network=testnet ` +
    `total_blocks=${S.totalBlocksObserved}i,total_txs=${S.totalTxsObserved}i,` +
    `first_block=${S.aggregateFirstBlock ?? 0}i,started_at=${S.aggregateStartedAt}i ` +
    `${ts}`
  );
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines.join('\n'),
      signal: AbortSignal.timeout(8_000),
    });
  } catch { /* non-critical */ }
}

async function hydrateAggregateFromInflux(): Promise<void> {
  try {
    // Per-miner latest snapshot.
    const q = `SELECT LAST(blocks) as blocks, LAST(txs) as txs, `
      + `LAST(first_block) as first_block, LAST(first_ts) as first_ts, `
      + `LAST(last_block) as last_block, LAST(last_ts) as last_ts `
      + `FROM monad_validator_aggregate WHERE network='testnet' GROUP BY miner`;
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}&epoch=ms`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return;
    const j = await res.json() as {
      results: Array<{
        series?: Array<{
          tags?: Record<string, string>;
          columns: string[];
          values: unknown[][];
        }>;
      }>;
    };
    const series = j.results?.[0]?.series ?? [];
    let restored = 0;
    for (const s of series) {
      const miner = s.tags?.miner;
      if (!miner) continue;
      const idx: Record<string, number> = {};
      s.columns.forEach((c, i) => { idx[c] = i; });
      const row = s.values?.[0];
      if (!row) continue;
      const blocks = Number(row[idx.blocks] ?? 0);
      if (!Number.isFinite(blocks) || blocks === 0) continue;
      S.minerAggregate.set(miner, {
        miner,
        blocks,
        txs: Number(row[idx.txs] ?? 0),
        firstSeenBlock: Number(row[idx.first_block] ?? 0),
        firstSeenTs: Number(row[idx.first_ts] ?? 0),
        lastSeenBlock: Number(row[idx.last_block] ?? 0),
        lastSeenTs: Number(row[idx.last_ts] ?? 0),
      });
      restored++;
    }
    // Restore meta totals.
    const metaQ = `SELECT LAST(total_blocks) as total_blocks, LAST(total_txs) as total_txs, `
      + `LAST(first_block) as first_block, LAST(started_at) as started_at `
      + `FROM monad_validator_aggregate_meta WHERE network='testnet'`;
    const mr = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(metaQ)}&epoch=ms`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (mr.ok) {
      const mj = await mr.json() as {
        results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>;
      };
      const ms = mj.results?.[0]?.series?.[0];
      if (ms?.values?.[0]) {
        const idx: Record<string, number> = {};
        ms.columns.forEach((c, i) => { idx[c] = i; });
        const row = ms.values[0];
        S.totalBlocksObserved = Number(row[idx.total_blocks] ?? 0);
        S.totalTxsObserved = Number(row[idx.total_txs] ?? 0);
        const firstBlock = Number(row[idx.first_block] ?? 0);
        if (firstBlock > 0) S.aggregateFirstBlock = firstBlock;
        const startedAt = Number(row[idx.started_at] ?? 0);
        if (startedAt > 0) S.aggregateStartedAt = startedAt;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[wsBlockStream] hydrated ${restored} miner aggregates from InfluxDB, total=${S.totalBlocksObserved} blocks`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[wsBlockStream] hydrate failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ── WebSocket lifecycle ───────────────────────────────────────────────────
function scheduleReconnect() {
  if (S.reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_MIN_MS * Math.pow(RECONNECT_BACKOFF, S.reconnectAttempts),
    RECONNECT_MAX_MS,
  );
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    S.reconnectAttempts++;
    connect();
  }, delay);
}

function connect() {
  if (S.ws) {
    try { S.ws.close(); } catch { /* ignore */ }
  }
  const ws = new WebSocket(WS_URL);
  S.ws = ws;

  ws.on('open', () => {
    S.connected = true;
    S.reconnectAttempts = 0;
    S.lastError = null;
    ws.send(JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_subscribe',
      params: ['newHeads'],
    }));
    // eslint-disable-next-line no-console
    console.log('[wsBlockStream] connected, subscribing to newHeads');
  });

  ws.on('message', (raw) => {
    let msg: { id?: number; result?: string; method?: string; params?: { result?: NewHeadPush } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Subscription confirmation
    if (msg.id === 1 && typeof msg.result === 'string') {
      S.subscriptionId = msg.result;
      // eslint-disable-next-line no-console
      console.log(`[wsBlockStream] subscribed sub=${msg.result}`);
      return;
    }
    // Block push
    if (msg.method === 'eth_subscription' && msg.params?.result) {
      const block = addHeader(msg.params.result);
      S.pushCount++;
      S.lastPushAt = Date.now();
      // Async enrich — single HTTP RPC method per block, no batching, no burst
      void enrichBlock(block.number);
    }
  });

  ws.on('error', (err) => {
    S.lastError = err.message;
    // eslint-disable-next-line no-console
    console.log(`[wsBlockStream] error: ${err.message}`);
  });

  ws.on('close', () => {
    S.connected = false;
    S.subscriptionId = null;
    S.ws = null;
    // eslint-disable-next-line no-console
    console.log(`[wsBlockStream] closed, reconnect attempt ${S.reconnectAttempts + 1}`);
    scheduleReconnect();
  });
}

// ── Public API ────────────────────────────────────────────────────────────
export function startWsBlockStream() {
  if (S.ws || S.reconnectTimer) return; // already running
  // eslint-disable-next-line no-console
  console.log(`[wsBlockStream] starting, ws=${WS_URL} ring=${RING_SIZE}`);
  S.startedAt = Date.now();
  // Hydrate from InfluxDB FIRST so participationLong is meaningful
  // immediately after PM2 restart instead of needing 30 min warmup.
  // hydrate() returns quickly (one query) so we don't block the WS connect.
  void hydrateAggregateFromInflux().finally(() => connect());

  // Periodically persist the aggregate so future restarts can hydrate.
  const g2 = globalThis as unknown as { __wsAggregateWriter__?: ReturnType<typeof setInterval> };
  if (!g2.__wsAggregateWriter__) {
    g2.__wsAggregateWriter__ = setInterval(() => { void writeAggregateSnapshot(); }, AGGREGATE_WRITE_INTERVAL_MS);
  }
}

/** Force-write a snapshot now (e.g. before clean shutdown). */
export function writeAggregateNow() {
  return writeAggregateSnapshot();
}

/** Get last N blocks from the ring (newest first). */
export function getLatestBlocks(n: number): RingBlock[] {
  const keys = [...S.ring.keys()].sort((a, b) => b - a);
  return keys.slice(0, n).map(k => S.ring.get(k)!);
}

/** Get a specific block by number. */
export function getBlock(num: number): RingBlock | undefined {
  return S.ring.get(num);
}

/** Get current tip block number, or null if ring empty. */
export function getTipNumber(): number | null {
  if (S.ring.size === 0) return null;
  let max = -1;
  for (const k of S.ring.keys()) if (k > max) max = k;
  return max;
}

/** Diagnostic info for /api/stats and admin pages. */
export function getStreamState() {
  return {
    connected: S.connected,
    subscriptionId: S.subscriptionId,
    ringSize: S.ring.size,
    tipNumber: getTipNumber(),
    pushCount: S.pushCount,
    enrichedCount: S.enrichedCount,
    enrichErrors: S.enrichErrors,
    enrichRate: S.pushCount > 0 ? S.enrichedCount / S.pushCount : 0,
    lastPushAt: S.lastPushAt,
    lastPushAgoMs: S.lastPushAt ? Date.now() - S.lastPushAt : null,
    lastError: S.lastError,
    reconnectAttempts: S.reconnectAttempts,
    uptimeMs: Date.now() - S.startedAt,
    aggregate: {
      uniqueMiners: S.minerAggregate.size,
      totalBlocks: S.totalBlocksObserved,
      totalTxs: S.totalTxsObserved,
      firstBlock: S.aggregateFirstBlock,
      windowMs: Date.now() - S.aggregateStartedAt,
    },
  };
}

/**
 * Cumulative per-miner aggregate since process start. Returns an array so
 * callers can sort/filter without paying Map iteration twice. Keys are
 * lowercase 0x addresses.
 */
export function getMinerAggregate(): MinerAggregate[] {
  return Array.from(S.minerAggregate.values());
}

/** Aggregate-level stats: how much data has accumulated. */
export function getAggregateState() {
  return {
    uniqueMiners: S.minerAggregate.size,
    totalBlocks: S.totalBlocksObserved,
    totalTxs: S.totalTxsObserved,
    firstBlock: S.aggregateFirstBlock,
    startedAt: S.aggregateStartedAt,
    windowMs: Date.now() - S.aggregateStartedAt,
  };
}
