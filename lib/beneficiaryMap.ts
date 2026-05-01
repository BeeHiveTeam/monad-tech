/**
 * Maps block.miner addresses (== validator beneficiary, set by operator in
 * node.toml) back to their validatorId by scanning `ValidatorRewarded` events
 * from the staking precompile.
 *
 * Why this exists: in Monad, `block.miner` is whatever the operator set as
 * `beneficiary` in node.toml. Most set it to authAddress, some set it to a
 * separate rewards wallet, and some leave it as `0x0`. Without this mapping
 * blocks under non-authAddress beneficiaries can't be attributed back to the
 * registered validator — they look like phantom producers, while their
 * validator looks like it has 0 uptime. See [[validator-scoring-semantics]]
 * for context.
 *
 * Mechanism:
 *   1. Foundation auto-delegator calls staking precompile every block to
 *      award 25 MON to the block's leader. This emits:
 *          ValidatorRewarded(uint64 indexed validatorId, address indexed from,
 *                            uint256 amount, uint64 epoch)
 *      Topic0 = keccak256("ValidatorRewarded(uint64,address,uint256,uint64)")
 *             = 0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754
 *      `validatorId` (topic1) is the rewarded validator = block leader.
 *   2. We scan logs over the last N blocks, build blockNumber → validatorId.
 *   3. Callers can then group blocks by their leader's validatorId (from this
 *      map) instead of by block.miner (which is the unreliable beneficiary).
 *
 * Cost: one eth_getLogs covers ~1000 blocks server-side filtered. Cheaper than
 * the per-block fetches we were doing before.
 */

import { MONAD_RPC_URL } from './config';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const TOPIC0_VALIDATOR_REWARDED =
  '0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754';
const SCAN_RANGE_BLOCKS = 5000;        // covers ~33 min at 0.4s blocks
const CHUNK_SIZE = 1000;               // RPC eth_getLogs window per request

interface BenefState {
  // blockNumber → validatorId rewarded for that block
  blockToValidator: Map<number, number>;
  // validatorId → set of beneficiary (block.miner) addresses observed
  validatorToBenef: Map<number, Set<string>>;
  highestBlockSeen: number;
  lastUpdatedAt: number;
}

const g = globalThis as unknown as { __monadBenefState__?: BenefState };
if (!g.__monadBenefState__) {
  g.__monadBenefState__ = {
    blockToValidator: new Map(),
    validatorToBenef: new Map(),
    highestBlockSeen: 0,
    lastUpdatedAt: 0,
  };
}
const S = g.__monadBenefState__!;

interface RpcLog {
  blockNumber: string;
  topics: string[];
}

async function fetchLogChunk(fromBlock: number, toBlock: number): Promise<RpcLog[]> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
    params: [{
      address: STAKING_PRECOMPILE,
      topics: [TOPIC0_VALIDATOR_REWARDED],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
    }],
  });
  const res = await fetch(MONAD_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const j = await res.json() as { result?: RpcLog[]; error?: { message: string } };
  if (j.error) return [];
  return j.result ?? [];
}

async function getLatestBlock(): Promise<number | null> {
  try {
    const res = await fetch(MONAD_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: string };
    return j.result ? parseInt(j.result, 16) : null;
  } catch { return null; }
}

/**
 * Background tick: refresh the blockToValidator map. On first run scans the
 * full SCAN_RANGE_BLOCKS window. On subsequent runs scans only blocks newer
 * than the highest one we've seen, so steady-state cost is tiny.
 *
 * Drops entries older than SCAN_RANGE_BLOCKS to keep memory bounded — the
 * map is only useful for blocks in the current sample window anyway.
 */
export async function tickBeneficiaryScanner(): Promise<void> {
  const tip = await getLatestBlock();
  if (tip === null) return;

  // Determine the from..to range to scan.
  const fromBlock = S.highestBlockSeen > 0
    ? Math.max(S.highestBlockSeen + 1, tip - SCAN_RANGE_BLOCKS)
    : tip - SCAN_RANGE_BLOCKS;
  const toBlock = tip;
  if (fromBlock > toBlock) return;

  // Chunk the request — most RPCs limit eth_getLogs to ~1000 blocks per call.
  for (let from = fromBlock; from <= toBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, toBlock);
    const logs = await fetchLogChunk(from, to);
    for (const log of logs) {
      const blockNum = parseInt(log.blockNumber, 16);
      const validatorId = parseInt(log.topics[1], 16);
      if (!S.blockToValidator.has(blockNum)) {
        S.blockToValidator.set(blockNum, validatorId);
      }
    }
  }

  S.highestBlockSeen = Math.max(S.highestBlockSeen, toBlock);

  // Drop entries older than our retention window.
  const dropBefore = tip - SCAN_RANGE_BLOCKS;
  for (const bn of S.blockToValidator.keys()) {
    if (bn < dropBefore) S.blockToValidator.delete(bn);
  }

  S.lastUpdatedAt = Date.now();
}

/** Returns the validatorId that produced a given block, or null if unknown. */
export function getValidatorIdForBlock(blockNumber: number): number | null {
  return S.blockToValidator.get(blockNumber) ?? null;
}

/** Diagnostic — returns scanner state for /api/ws-state or similar surfaces. */
export function getBeneficiaryMapState(): {
  size: number;
  highestBlock: number;
  lastUpdatedAt: number;
  ageMs: number;
} {
  return {
    size: S.blockToValidator.size,
    highestBlock: S.highestBlockSeen,
    lastUpdatedAt: S.lastUpdatedAt,
    ageMs: S.lastUpdatedAt > 0 ? Date.now() - S.lastUpdatedAt : -1,
  };
}

/**
 * Record a beneficiary observation — called from /api/validators when it
 * sees `block.miner = X` for a block whose validatorId we know. Lets us
 * expose `beneficiary` field per validator without an extra fetch.
 */
export function recordBeneficiary(validatorId: number, beneficiary: string): void {
  let set = S.validatorToBenef.get(validatorId);
  if (!set) { set = new Set(); S.validatorToBenef.set(validatorId, set); }
  set.add(beneficiary.toLowerCase());
}

/** Returns the (canonical / most-recent) beneficiary for a validator. */
export function getBeneficiaryForValidator(validatorId: number): string | null {
  const set = S.validatorToBenef.get(validatorId);
  if (!set || set.size === 0) return null;
  // Just return any — operators rarely change beneficiary
  return set.values().next().value ?? null;
}
