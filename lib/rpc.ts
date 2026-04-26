import { NETWORKS, NetworkId } from './networks';

function getRpcUrl(network: NetworkId): string {
  if (network === 'testnet' && process.env.MONAD_RPC_URL) {
    return process.env.MONAD_RPC_URL;
  }
  return NETWORKS[network].rpc;
}

async function rpcCall(network: NetworkId, method: string, params: unknown[] = []) {
  const url = getRpcUrl(network);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// JSON-RPC batch: one HTTP request, array of methods, array of results back.
export async function rpcBatch(network: NetworkId, requests: { method: string; params: unknown[] }[]) {
  const url = getRpcUrl(network);
  const body = requests.map((r, i) => ({
    jsonrpc: '2.0', id: i, method: r.method, params: r.params,
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json() as { id: number; result?: unknown; error?: { message: string } }[];
  // Sort by id to preserve order
  const sorted = new Array(requests.length);
  for (const item of json) {
    if (typeof item.id === 'number') sorted[item.id] = item.result ?? null;
  }
  return sorted as unknown[];
}

export async function getBlockNumber(network: NetworkId): Promise<bigint> {
  const hex = await rpcCall(network, 'eth_blockNumber');
  return BigInt(hex);
}

export async function getBlock(network: NetworkId, blockNumber: bigint | 'latest', full = false) {
  const tag = blockNumber === 'latest' ? 'latest' : `0x${blockNumber.toString(16)}`;
  return rpcCall(network, 'eth_getBlockByNumber', [tag, full]);
}

export async function getGasPrice(network: NetworkId): Promise<bigint> {
  const hex = await rpcCall(network, 'eth_gasPrice');
  return BigInt(hex);
}

export async function getLatestBlocks(network: NetworkId, count = 20) {
  const latestHex = await rpcCall(network, 'eth_blockNumber');
  const latest = parseInt(latestHex, 16);

  const promises = Array.from({ length: count }, (_, i) => {
    const num = latest - i;
    const tag = `0x${num.toString(16)}`;
    return rpcCall(network, 'eth_getBlockByNumber', [tag, true]).catch(() => null);
  });

  const blocks = await Promise.all(promises);
  return blocks.filter(Boolean);
}

export async function getLatestBlocksBatched(
  network: NetworkId,
  count: number,
  fullTx = false,
  batchSize?: number,
  pauseMs?: number,
) {
  const local = !!(network === 'testnet' && process.env.MONAD_RPC_URL);
  const latestHex = await rpcCall(network, 'eth_blockNumber');
  const latest = parseInt(latestHex, 16);

  if (local) {
    // Use JSON-RPC batching: one HTTP request per batch. Default batch=500.
    // Between batches pause `pauseMs` (default 200ms for local) so a long
    // multi-batch fetch (e.g. 5000-block validators refresh) doesn't saturate
    // the RPC's triedb_env channel or block the Node.js event loop, which
    // would in turn cause tpsCollector to skip ticks and burst-catch-up.
    const _batchSize = batchSize ?? 500;
    const _pauseMs = pauseMs ?? 200;
    const all: unknown[] = [];
    for (let offset = 0; offset < count; offset += _batchSize) {
      const size = Math.min(_batchSize, count - offset);
      const requests = Array.from({ length: size }, (_, i) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${(latest - offset - i).toString(16)}`, fullTx],
      }));
      const results = await rpcBatch(network, requests);
      all.push(...results.filter(Boolean));
      if (_pauseMs > 0 && offset + _batchSize < count) {
        await new Promise(r => setTimeout(r, _pauseMs));
      }
    }
    return all;
  }

  // Public RPC: parallel individual requests with rate-limit pauses
  const _batchSize = batchSize ?? 40;
  const _pauseMs = pauseMs ?? 1100;
  const all: unknown[] = [];
  for (let offset = 0; offset < count; offset += _batchSize) {
    const size = Math.min(_batchSize, count - offset);
    const batch = Array.from({ length: size }, (_, i) => {
      const tag = `0x${(latest - offset - i).toString(16)}`;
      return rpcCall(network, 'eth_getBlockByNumber', [tag, fullTx]).catch(() => null);
    });
    const results = await Promise.all(batch);
    all.push(...results.filter(Boolean));
    if (_pauseMs > 0 && offset + _batchSize < count) {
      await new Promise(r => setTimeout(r, _pauseMs));
    }
  }
  return all;
}

export async function getChainId(network: NetworkId): Promise<number> {
  const hex = await rpcCall(network, 'eth_chainId');
  return parseInt(hex, 16);
}
