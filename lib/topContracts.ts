/**
 * Aggregates top contracts by retry appearance rate.
 *
 * Semantics: for each `to` address seen in tx across a window of blocks:
 *   - `blocks` = distinct blocks the contract appeared in
 *   - `retried` = of those, how many had block-level rtp > 0 (at least one
 *     parallel-execution conflict anywhere in the block)
 *   - `avgRtp` = mean rtp across the blocks it appeared in
 *   - `tx` = total number of tx targeting that contract
 *
 * This is a proxy metric: rtp is per-block, not per-tx, so high correlation
 * doesn't prove causation. Contracts that appear in blocks with many retries
 * are *likely* contributors to parallelism conflicts.
 *
 * Same approach as ops.rustemar.dev ("ranked by appearance in blocks with
 * retry_pct>0"). We additionally expose avg rtp and total tx count.
 */

import { rpcBatch, getBlockNumber } from './rpc';
import { NetworkId } from './networks';
import { ExecStat, fetchExecStats } from './execStats';

export interface ContractRow {
  address: string;
  blocks: number;
  retried: number;
  retriedShare: number;
  avgRtp: number;
  tx: number;
}

interface BlockTxs {
  number: number;
  // Lowercased `to` addresses (duplicates preserved so `tx` count is correct)
  tos: string[];
}

// BATCH_SIZE 500 → 25: per [[monad-rpc-pacing]] hard rule. Combined with ring
// buffer (lib/wsBlockStream) — most recent ~1000 blocks served from RAM, RPC
// fetch only for older blocks beyond ring window.
const BATCH_SIZE = 25;

async function fetchBlocksWithTxs(
  network: NetworkId,
  blockNumbers: number[],
): Promise<BlockTxs[]> {
  if (blockNumbers.length === 0) return [];

  // First pass: serve any blocks already in the WebSocket ring buffer.
  // The ring holds the last ~1000 blocks fully enriched (txs included).
  // For 5m windows (~750 blocks) this covers 100%, eliminating all RPC.
  // For 15m+ windows older blocks fall through to RPC fetch below.
  const { getBlock: getRingBlock } = await import('./wsBlockStream');
  const out: BlockTxs[] = [];
  const missing: number[] = [];
  for (const n of blockNumbers) {
    const r = getRingBlock(n);
    if (r && r.txs !== null) {
      const tos: string[] = [];
      for (const tx of r.txs) {
        if (tx.to) tos.push(tx.to.toLowerCase());
      }
      out.push({ number: n, tos });
    } else {
      missing.push(n);
    }
  }
  if (missing.length === 0) return out;

  // Second pass: RPC fetch for blocks not in ring. Small batches (25) at
  // ~200ms natural pacing — well under triedb_env channel drain rate.
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const chunk = missing.slice(i, i + BATCH_SIZE);
    const requests = chunk.map(n => ({
      method: 'eth_getBlockByNumber' as const,
      params: [`0x${n.toString(16)}`, true] as unknown[],
    }));
    const results = await rpcBatch(network, requests);

    for (let j = 0; j < chunk.length; j++) {
      const b = results[j] as {
        number?: string;
        transactions?: Array<{ to: string | null }>;
      } | null;
      if (!b) continue;
      const tos: string[] = [];
      for (const tx of b.transactions ?? []) {
        if (tx.to) tos.push(tx.to.toLowerCase());
      }
      out.push({ number: chunk[j], tos });
    }
    // Pause between batches so the channel can drain. 200ms is the same
    // pacing used by getLatestBlocksBatched for local RPC.
    if (i + BATCH_SIZE < missing.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return out;
}

export interface TopContractsResult {
  window: string;
  windowSeconds: number;
  blocksAnalyzed: number;
  totalTx: number;
  fetchedAt: number;
  rows: ContractRow[];
}

/**
 * The core work: correlate exec stats with block tx data to rank contracts.
 * `minAppearances` filters noise.
 */
export async function computeTopContracts(
  network: NetworkId,
  windowSeconds: number,
  minAppearances: number,
  limit: number,
): Promise<TopContractsResult> {
  // 1. Exec stats from Loki — one entry per block, contains rtp/rt.
  const execs = await fetchExecStats(windowSeconds, 5000);
  if (execs.length === 0) {
    return {
      window: `${windowSeconds}s`, windowSeconds, blocksAnalyzed: 0,
      totalTx: 0, fetchedAt: Date.now(), rows: [],
    };
  }

  const execByBlock = new Map<number, ExecStat>();
  for (const e of execs) execByBlock.set(e.block, e);
  const blockNumbers = execs.map(e => e.block);

  // 2. Fetch tx lists for those blocks from RPC.
  const blocks = await fetchBlocksWithTxs(network, blockNumbers);

  // 3. Aggregate per contract.
  type Acc = { blocks: Set<number>; retried: number; rtpSum: number; tx: number };
  const agg = new Map<string, Acc>();
  let totalTx = 0;

  for (const b of blocks) {
    const exec = execByBlock.get(b.number);
    if (!exec) continue;
    const isRetried = exec.rt > 0;
    const rtp = exec.rtp;

    // One "appearance" per (contract, block) pair — don't double-count if a
    // contract is called multiple times in the same block.
    const seenInBlock = new Set<string>();
    for (const to of b.tos) {
      totalTx++;
      if (!seenInBlock.has(to)) {
        seenInBlock.add(to);
        let a = agg.get(to);
        if (!a) { a = { blocks: new Set(), retried: 0, rtpSum: 0, tx: 0 }; agg.set(to, a); }
        a.blocks.add(b.number);
        if (isRetried) a.retried++;
        a.rtpSum += rtp;
      }
      // Still count every tx to this contract for `tx` column.
      const a = agg.get(to);
      if (a) a.tx++;
    }
  }

  // 4. Build rows, filter, sort.
  const rows: ContractRow[] = [];
  for (const [address, a] of agg) {
    const blocksCount = a.blocks.size;
    if (blocksCount < minAppearances) continue;
    rows.push({
      address,
      blocks: blocksCount,
      retried: a.retried,
      retriedShare: +((a.retried / blocksCount) * 100).toFixed(2),
      avgRtp: +(a.rtpSum / blocksCount).toFixed(2),
      tx: a.tx,
    });
  }
  // Rank primarily by retriedShare × avgRtp (composite), then by tx for tie-break.
  rows.sort((x, y) => {
    const sx = x.retriedShare * (x.avgRtp / 100) * Math.log10(1 + x.blocks);
    const sy = y.retriedShare * (y.avgRtp / 100) * Math.log10(1 + y.blocks);
    if (sy !== sx) return sy - sx;
    return y.tx - x.tx;
  });

  return {
    window: `${windowSeconds}s`,
    windowSeconds,
    blocksAnalyzed: blocks.length,
    totalTx,
    fetchedAt: Date.now(),
    rows: rows.slice(0, limit),
  };
}

// -- Simple in-memory cache ---------------------------------------------------
// Computing top contracts is expensive (RPC batch of 1000+ blocks) so we cache
// each (network, window, min, limit) response for a short TTL.
interface CacheEntry { at: number; data: TopContractsResult }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export async function getTopContractsCached(
  network: NetworkId,
  windowSeconds: number,
  minAppearances: number,
  limit: number,
): Promise<TopContractsResult> {
  const key = `${network}|${windowSeconds}|${minAppearances}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await computeTopContracts(network, windowSeconds, minAppearances, limit);
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Suppress unused-export warning while letting this stay internally importable.
export { getBlockNumber };
