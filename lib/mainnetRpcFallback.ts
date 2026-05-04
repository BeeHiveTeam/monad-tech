/**
 * Round-robin fallback for mainnet RPC. The configured primary
 * (https://rpc.monad.xyz, Foundation/QuickNode-backed) rate-limits at
 * 25 req/sec — combined load from tipCache + /api/stats fallback +
 * validator-registry occasionally trips this and stats start returning 0.
 *
 * On failure (429 / -32007 / timeout / 5xx) callers should:
 *   1. invoke rotateMainnetRpc(reason) to advance the active URL
 *   2. retry their fetch with the new URL
 *
 * Testnet is unaffected — we always use our own validator there.
 *
 * Tatum is excluded from the fallback list because its public tier is
 * rate-limited at 5 req/min, which would make us flap on every other
 * request.
 */

import rpcsCatalog from '@/data/monad-rpcs.json';
import { NetworkId } from './networks';

interface RpcEntry {
  network: string;
  provider: string;
  http: string;
  ws: string | null;
  notes?: string;
}

const PROVIDER_BLOCKLIST = new Set([
  'Tatum',  // 5 req/min on public tier — useless as fallback
]);

function buildMainnetFallbacks(): string[] {
  const primary = process.env.MONAD_MAINNET_RPC || 'https://rpc.monad.xyz';
  const fromCatalog = (rpcsCatalog.rpcs as RpcEntry[])
    .filter(r => r.network === 'mainnet' && !PROVIDER_BLOCKLIST.has(r.provider) && r.http)
    .map(r => r.http);
  // Primary first, then everything from catalog (deduped).
  return Array.from(new Set([primary, ...fromCatalog]));
}

const FALLBACKS: Record<NetworkId, string[]> = {
  testnet: [],  // unused — testnet always uses our validator
  mainnet: buildMainnetFallbacks(),
};

// Active index per network, on globalThis so HMR / multiple module copies
// converge on the same rotation state.
const g = globalThis as { __monadRpcActiveIdx__?: Record<NetworkId, number> };
if (!g.__monadRpcActiveIdx__) g.__monadRpcActiveIdx__ = { testnet: 0, mainnet: 0 };

export function getActiveMainnetRpc(): string {
  const list = FALLBACKS.mainnet;
  if (list.length === 0) return process.env.MONAD_MAINNET_RPC || 'https://rpc.monad.xyz';
  return list[g.__monadRpcActiveIdx__!.mainnet % list.length];
}

export function rotateMainnetRpc(reason?: string): string {
  const list = FALLBACKS.mainnet;
  if (list.length <= 1) return list[0] ?? 'https://rpc.monad.xyz';
  const before = list[g.__monadRpcActiveIdx__!.mainnet % list.length];
  g.__monadRpcActiveIdx__!.mainnet = (g.__monadRpcActiveIdx__!.mainnet + 1) % list.length;
  const after = list[g.__monadRpcActiveIdx__!.mainnet % list.length];
  // eslint-disable-next-line no-console
  console.warn(`[rpc-fallback] mainnet ${before} → ${after}${reason ? ` (${reason})` : ''}`);
  return after;
}

/**
 * Heuristic: detect errors that mean "this RPC is busted, try a different one".
 * Catches HTTP 429, JSON-RPC -32007, common rate-limit phrasing, timeouts,
 * 5xx-bracket text. Conservative: returns true on common transient failures.
 */
export function isTransientRpcError(err: unknown, httpStatus?: number): boolean {
  if (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\brate\b|\blimit\b|429|-32007|too many|timeout|aborted|econnreset|enotfound|fetch failed/i.test(msg);
}

/**
 * Resolve URL to use for a single mainnet RPC call. Testnet always returns
 * the configured testnet URL.
 */
export function rpcUrlFor(network: NetworkId): string {
  if (network === 'testnet') {
    return process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
  }
  return getActiveMainnetRpc();
}

/**
 * Diagnostic exposure — useful for /api/ws-state and similar.
 */
export function getMainnetRpcState() {
  return {
    fallbackList: FALLBACKS.mainnet,
    activeIndex: g.__monadRpcActiveIdx__!.mainnet,
    activeUrl: getActiveMainnetRpc(),
  };
}
