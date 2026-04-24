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

const LOCAL_RPC = process.env.MONAD_RPC_URL;
const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz';
const RPC_URL = LOCAL_RPC || PUBLIC_RPC;

const TIP_TTL_MS = 500;

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

const g = globalThis as { __monadTipCache__?: { tip: CachedTip | null; inflight: Promise<TipBlock> | null } };
if (!g.__monadTipCache__) g.__monadTipCache__ = { tip: null, inflight: null };
const S = g.__monadTipCache__;

async function fetchTipFresh(): Promise<TipBlock> {
  const res = await fetch(RPC_URL, {
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
 * Returns the current tip block. Callers are deduplicated: if a fetch is in
 * flight when called, we await the in-flight promise instead of starting a
 * second identical request.
 */
export async function getTip(): Promise<TipBlock> {
  const now = Date.now();
  if (S.tip && now - S.tip.fetchedAt < TIP_TTL_MS) {
    return S.tip.data;
  }
  if (S.inflight) {
    return S.inflight;
  }
  const p = fetchTipFresh()
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
export async function getTipNumber(): Promise<number> {
  const t = await getTip();
  return t.number;
}
