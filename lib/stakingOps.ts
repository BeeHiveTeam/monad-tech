/**
 * Staking operations scanner + persistence.
 *
 * Monad's staking precompile (0x…1000) accepts direct transactions:
 *   to    = 0x0000000000000000000000000000000000001000
 *   value = amount to stake (in wei)
 *   input = <selector(4 bytes)><target_payload(32 bytes, ABI-padded)>
 *
 * Example observed on testnet:
 *   selector 0x791bdcf3 (Monad-specific, likely "distribute/delegate")
 *   payload  = 20-byte target identifier (NOT authAddress, NOT secp pubkey
 *              prefix — some signing-level identifier. We store raw and let
 *              consumers map later.)
 *
 * This module:
 *   1. Scans new blocks incrementally via JSON-RPC batches
 *   2. Extracts every tx with to == staking precompile
 *   3. Writes each event to InfluxDB `monad_staking_ops`
 *   4. Exposes read helpers for aggregating by target or by delegator
 */

import { rpcBatch } from './rpc';
import { NetworkId } from './networks';

const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';
const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';

export interface StakingOp {
  blockNumber: number;
  txHash: string;
  timestamp: number;          // seconds (from block)
  selector: string;           // 10-char hex '0x<4bytes>'
  delegator: string;          // tx.from (lowercased)
  target: string;             // lowercased 20-byte identifier from input payload
  amountWei: string;          // big, keep as decimal string to avoid precision loss
  amountMon: number;          // convenience — amountWei / 1e18
}

interface ScannerState {
  lastBlock: number;          // highest block scanned
}
const g = globalThis as { __monadStakingScanner__?: ScannerState };
if (!g.__monadStakingScanner__) g.__monadStakingScanner__ = { lastBlock: 0 };
const S = g.__monadStakingScanner__!;

// Fire-and-forget Influx write; failures are non-critical.
async function influxWrite(lines: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines,
      signal: AbortSignal.timeout(4_000),
    });
  } catch { /* swallow */ }
}

function escTag(s: string): string {
  return s.replace(/[, =]/g, '_');
}

function toLine(op: StakingOp, network: string): string {
  return `monad_staking_ops,network=${network},target=${escTag(op.target)},delegator=${escTag(op.delegator)},selector=${escTag(op.selector)} ` +
    `block=${op.blockNumber}i,amount=${op.amountMon},tx="${op.txHash}" ` +
    `${op.timestamp * 1000}`;
}

interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
}
interface RpcBlock {
  number: string;
  timestamp: string;
  transactions: RpcTx[];
}

/**
 * Parse a single transaction → staking op, or null if it isn't one.
 */
function parseStakingTx(tx: RpcTx, blockNumber: number, timestamp: number): StakingOp | null {
  if (!tx.to || tx.to.toLowerCase() !== STAKING_PRECOMPILE) return null;
  const input = tx.input || '0x';
  if (input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  // Target payload = last 20 bytes of first ABI slot (skip 12 bytes of left-pad).
  // Input layout: 0x<selector>(4B) + <arg0>(32B) + <arg1>(32B)...
  let target = '';
  if (input.length >= 10 + 64) {
    target = '0x' + input.slice(10 + 24, 10 + 64).toLowerCase();
  }
  const amountWei = BigInt(tx.value || '0x0');
  return {
    blockNumber,
    txHash: tx.hash,
    timestamp,
    selector,
    delegator: tx.from.toLowerCase(),
    target,
    amountWei: amountWei.toString(),
    amountMon: Number(amountWei) / 1e18,
  };
}

/**
 * Incrementally scan new blocks since last run; write any staking ops found.
 * Called from instrumentation.ts every 15s.
 */
export async function tickStakingScanner(network: NetworkId = 'testnet'): Promise<void> {
  try {
    const tipHex = (await rpcBatch(network, [{ method: 'eth_blockNumber', params: [] }]))[0] as string;
    const tip = parseInt(tipHex, 16);
    if (!Number.isFinite(tip) || tip <= 0) return;

    // First run → seed from current tip, don't backfill.
    if (S.lastBlock === 0) {
      S.lastBlock = tip - 1;
      return;
    }
    if (tip <= S.lastBlock) return;

    // Cap per-tick to avoid unbounded catch-up bursts.
    const MAX_PER_TICK = 100;
    const from = S.lastBlock + 1;
    const to = Math.min(tip, from + MAX_PER_TICK - 1);

    // Fetch blocks with full tx data in one batch.
    const requests = [];
    for (let n = from; n <= to; n++) {
      requests.push({
        method: 'eth_getBlockByNumber',
        params: [`0x${n.toString(16)}`, true] as unknown[],
      });
    }
    const results = await rpcBatch(network, requests) as Array<RpcBlock | null>;

    const ops: StakingOp[] = [];
    for (const block of results) {
      if (!block?.transactions) continue;
      const blockNum = parseInt(block.number, 16);
      const ts = parseInt(block.timestamp, 16);
      for (const tx of block.transactions) {
        const op = parseStakingTx(tx, blockNum, ts);
        if (op) ops.push(op);
      }
    }

    if (ops.length > 0) {
      const body = ops.map(op => toLine(op, network)).join('\n');
      await influxWrite(body);
    }

    S.lastBlock = to;
  } catch {
    // Non-fatal — next tick retries.
  }
}

// ─── Read helpers ──────────────────────────────────────────────────────────

export interface DelegatorSummary {
  delegator: string;
  totalMon: number;
  opCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

/**
 * All staking ops within range, targeting a specific identifier.
 * `target` is the 20-byte hex from tx input payload (lowercased).
 */
export async function getDelegatorsByTarget(
  target: string,
  rangeSeconds: number,
): Promise<DelegatorSummary[]> {
  const q = `SELECT delegator, amount, time ` +
    `FROM monad_staking_ops ` +
    `WHERE target='${target.toLowerCase()}' AND time > now()-${rangeSeconds}s`;
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}&epoch=ms`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const j = await res.json() as {
      results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>
    };
    const series = j.results?.[0]?.series?.[0];
    if (!series?.values?.length) return [];
    const idx: Record<string, number> = {};
    series.columns.forEach((c, i) => { idx[c] = i; });

    const agg = new Map<string, DelegatorSummary>();
    for (const row of series.values) {
      const delegator = String(row[idx.delegator] ?? '');
      const amt = Number(row[idx.amount] ?? 0);
      const t = Number(row[idx.time] ?? 0);
      let entry = agg.get(delegator);
      if (!entry) {
        entry = { delegator, totalMon: 0, opCount: 0, firstSeenMs: t, lastSeenMs: t };
        agg.set(delegator, entry);
      }
      entry.totalMon += amt;
      entry.opCount += 1;
      if (t < entry.firstSeenMs) entry.firstSeenMs = t;
      if (t > entry.lastSeenMs) entry.lastSeenMs = t;
    }
    return Array.from(agg.values()).sort((a, b) => b.totalMon - a.totalMon);
  } catch {
    return [];
  }
}

export interface StakingOpListItem {
  blockNumber: number;
  txHash: string;
  timeMs: number;
  selector: string;
  delegator: string;
  target: string;
  amountMon: number;
}

/**
 * Raw ops for a target (or ALL if target undefined) with limit.
 * Used for "Recent activity" timelines.
 */
export async function getRecentOps(
  rangeSeconds: number,
  limit: number = 50,
  target?: string,
): Promise<StakingOpListItem[]> {
  let where = `time > now()-${rangeSeconds}s`;
  if (target) where += ` AND target='${target.toLowerCase()}'`;
  const q = `SELECT block, selector, delegator, target, amount, time FROM monad_staking_ops ` +
    `WHERE ${where} ORDER BY time DESC LIMIT ${limit}`;
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}&epoch=ms`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const j = await res.json() as {
      results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>
    };
    const series = j.results?.[0]?.series?.[0];
    if (!series?.values?.length) return [];
    const idx: Record<string, number> = {};
    series.columns.forEach((c, i) => { idx[c] = i; });

    return series.values.map(row => ({
      blockNumber: Number(row[idx.block] ?? 0),
      txHash: '',          // not returned by group-by query; can fetch separately if needed
      timeMs: Number(row[idx.time] ?? 0),
      selector: String(row[idx.selector] ?? ''),
      delegator: String(row[idx.delegator] ?? ''),
      target: String(row[idx.target] ?? ''),
      amountMon: Number(row[idx.amount] ?? 0),
    }));
  } catch {
    return [];
  }
}
