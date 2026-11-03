import { NetworkId } from './networks';
import { rpcUrlFor } from './mainnetRpcFallback';

export interface EpochState {
  current: number | null;
  inEpochDelayPeriod: boolean | null;
  fetchedAt: number | null;
  source: 'staking-precompile' | 'unavailable';
}
const TTL_MS = 5_000;
const states = new Map<NetworkId, { at: number; value: EpochState }>();
const pending = new Map<NetworkId, Promise<EpochState>>();

export function decodeEpochState(raw: unknown): { current: number; inEpochDelayPeriod: boolean } | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(raw)) return null;
  const epoch = BigInt('0x' + raw.slice(2, 66));
  const delay = BigInt('0x' + raw.slice(66));
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER) || (delay !== BigInt(0) && delay !== BigInt(1))) return null;
  return { current: Number(epoch), inEpochDelayPeriod: delay === BigInt(1) };
}

/** No block-height fallback: rounds and the delayed epoch transition are different. */
export async function getEpochState(network: NetworkId): Promise<EpochState> {
  const cached = states.get(network);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const inflight = pending.get(network);
  if (inflight) return inflight;
  const promise = (async (): Promise<EpochState> => {
    try {
      const r = await fetch(rpcUrlFor(network), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [
          { to: '0x0000000000000000000000000000000000001000', data: '0x757991a8' }, 'latest',
        ] }), signal: AbortSignal.timeout(3_000),
      });
      if (!r.ok) throw new Error('Epoch RPC unavailable');
      const j = await r.json() as { result?: unknown; error?: unknown };
      const value = !j.error ? decodeEpochState(j.result) : null;
      if (!value) throw new Error('Invalid epoch response');
      return { ...value, fetchedAt: Date.now(), source: 'staking-precompile' };
    } catch {
      return { current: null, inEpochDelayPeriod: null, fetchedAt: null, source: 'unavailable' };
    }
  })().then(value => {
    states.set(network, { at: Date.now(), value });
    return value;
  }).finally(() => { pending.delete(network); });
  pending.set(network, promise);
  return promise;
}
