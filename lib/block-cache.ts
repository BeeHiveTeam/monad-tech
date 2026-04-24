type RawBlock = {
  miner: string;
  number: string;
  timestamp: string;
  transactions: unknown[];
  hash: string;
  gasUsed?: string;
  gasLimit?: string;
};

interface BlockCache {
  blocks: RawBlock[];
  ts: number;
}

const cache = new Map<string, BlockCache>();

export function setBlockCache(network: string, blocks: RawBlock[]): void {
  cache.set(network, { blocks, ts: Date.now() });
}

export function getBlockCache(network: string, maxAgeMs = 5 * 60_000): RawBlock[] | null {
  const entry = cache.get(network);
  if (!entry || Date.now() - entry.ts > maxAgeMs) return null;
  return entry.blocks;
}
