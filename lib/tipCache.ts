/**
 * Shared cache for the chain's latest block number & latest block header.
 * Multiple callers (tps collector, reorg detector, /api/stats, /api/blocks)
 * all want `eth_blockNumber` and/or `eth_getBlockByNumber('latest')` every
 * second or two. Without coordination that's 3-4× the same request hitting
 * monad-rpc with no new information.
 *
 * 500ms TTL is tuned to Monad's ~0.4s block time — the cache expires about
 * once per new block, which is as fresh as we can reliably be anyway.
 */

import { NETWORKS, NetworkId } from './networks';

const TIP_TTL_MS = 500;

function rpcUrlFor(network: NetworkId): string {
  if (network === 'testnet' && process.env.MONAD_RPC_URL) return process.env.MONAD_RPC_URL;
  return NETWORKS[network].rpc;
}

interface TipBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestampHex: string;
  timestamp: number;
}

interface CachedTip {
  data: TipBlock;
  fetchedAt: number;
}

interface PerNetworkState {
  tip: CachedTip | null;
  inflight: Promise<TipBlock> | null;
}

const g = globalThis as { __monadTipCache__?: Map<NetworkId, PerNetworkState> };
if (!g.__monadTipCache__) g.__monadTipCache__ = new Map();
function stateFor(network: NetworkId): PerNetworkState {
  let s = g.__monadTipCache__!.get(network);
  if (!s) { s = { tip: null, inflight: null }; g.__monadTipCache__!.set(network, s); }
  return s;
}

async function fetchTipFresh(network: NetworkId): Promise<TipBlock> {
  const res = await fetch(rpcUrlFor(network), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`tipCache HTTP ${res.status}`);
  const j = await res.json() as { result?: {
    number: string; hash: string; parentHash: string; timestamp: string;
  }};
  const r = j.result;
  if (!r) throw new Error('tipCache: empty result');
  return {
    number: parseInt(r.number, 16),
    hash: r.hash,
    parentHash: r.parentHash,
    timestampHex: r.timestamp,
    timestamp: parseInt(r.timestamp, 16),
  };
}

/**
 * Returns the current tip block. Callers are deduplicated per-network:
 * if a fetch is in flight, we await the in-flight promise instead of
 * starting a second identical request. State is keyed by network so
 * testnet and mainnet caches don't clobber each other.
 */
export async function getTip(network: NetworkId = 'testnet'): Promise<TipBlock> {
  const S = stateFor(network);
  const now = Date.now();
  if (S.tip && now - S.tip.fetchedAt < TIP_TTL_MS) {
    return S.tip.data;
  }
  if (S.inflight) {
    return S.inflight;
  }
  const p = fetchTipFresh(network)
    .then(data => {
      S.tip = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => { S.inflight = null; });
  S.inflight = p;
  return p;
}

/**
 * Convenience for callers that only want the block number.
 */
export async function getTipNumber(network: NetworkId = 'testnet'): Promise<number> {
  const t = await getTip(network);
  return t.number;
}
