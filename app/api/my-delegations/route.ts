import { NextRequest, NextResponse } from 'next/server';
import { rpcBatch } from '@/lib/rpc';
import { ensureRegistryLoaded, getChainDataById, getConsensusIds, getRegistryStatus } from '@/lib/validator-registry';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { isInActiveSet } from '@/lib/validatorMetrics';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { apiError } from '@/lib/apiError';

export const dynamic = 'force-dynamic';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const SEL_GET_DELEGATOR = '0x573c1ce0'; // getDelegator(uint64,address) → returns delegator's stake at this validator
const RPC_BATCH_SIZE = 25;

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const _cache = new Map<string, { ts: number; data: Record<string, unknown> }>();
const _inFlight = new Map<string, Promise<Record<string, unknown>>>();
const MAX_CACHE_ENTRIES = 100;
const MAX_CONCURRENT_SCANS = 8;
const CACHE_TTL_MS = 60_000;

function pad32(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}
function encGetDelegator(validatorId: number, addr: string): string {
  return SEL_GET_DELEGATOR + pad32(validatorId.toString(16)) + pad32(addr.replace(/^0x/, ''));
}
function decodeStakeMon(raw: unknown): number | null {
  // Empty/error/null JSON-RPC results are unmeasured, never a zero balance.
  if (typeof raw !== 'string' || !/^0x(?:[a-fA-F0-9]{64})+$/.test(raw)) return null;
  try {
    const stake = Number(BigInt('0x' + raw.slice(2, 66))) / 1e18;
    return Number.isFinite(stake) ? stake : null;
  } catch { return null; }
}

function pruneCache(now: number) {
  for (const [key, entry] of _cache) {
    if (now - entry.ts >= CACHE_TTL_MS) _cache.delete(key);
  }
  while (_cache.size > MAX_CACHE_ENTRIES) _cache.delete(_cache.keys().next().value!);
}

async function scan(network: NetworkId, rawAddr: string): Promise<Record<string, unknown>> {
  const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
    ? process.env.MONAD_RPC_URL
    : NETWORKS[network].rpc;
  await ensureRegistryLoaded(rpcUrl, network);
  const registry = getRegistryStatus(network);
  // Snapshot the IDs and metadata: an asynchronous registry refresh must not
  // change the denominator or move a scan's positions between validator IDs.
  const chainData = new Map(getChainDataById(network));
  if (!registry.complete && chainData.size === 0) {
    return {
      network, address: rawAddr, building: !registry.error,
      error: registry.error ? 'Validator registry is unavailable. Please retry.' : undefined,
      message: 'Validator registry is still loading.',
      complete: false, partial: false, registryStale: registry.stale,
      validatorsTotal: 0, validatorsScanned: 0, validatorsFailed: 0,
      positionCount: 0, positions: [], totalStakeMon: 0, fetchedAt: Date.now(),
    };
  }

  const ids = [...chainData.keys()];
  const stakeByVid = new Map<number, number>();
  let validatorsScanned = 0;
  const deadline = Date.now() + 25_000;
  for (let i = 0; i < ids.length; i += RPC_BATCH_SIZE) {
    if (Date.now() >= deadline) break;
    const idsSlice = ids.slice(i, i + RPC_BATCH_SIZE);
    const calls = idsSlice.map(id => ({
      method: 'eth_call',
      params: [{ to: STAKING_PRECOMPILE, data: encGetDelegator(id, rawAddr) }, 'latest'] as unknown[],
    }));
    let results: unknown[];
    try { results = await rpcBatch(network, calls); }
    catch { continue; }
    // Iterate the requested IDs, not the response array: holes or short batches
    // count as failed reads rather than disappearing from the denominator.
    idsSlice.forEach((id, index) => {
      const stake = decodeStakeMon(results[index]);
      if (stake === null) return;
      validatorsScanned++;
      if (stake > 0) stakeByVid.set(id, stake);
    });
  }

  const consensusIds = getConsensusIds(network);
  const positions = [...stakeByVid].map(([validatorId, stakeMon]) => {
    const chain = chainData.get(validatorId)!;
    const info = getValidatorInfo(chain.authAddress, network);
    return {
      validatorId, authAddress: chain.authAddress, moniker: info?.moniker ?? null,
      stakeMon, commissionPct: chain.commissionPct ?? null,
      isActiveSet: isInActiveSet(validatorId, chain.stakeMon ?? null, consensusIds),
    };
  }).sort((a, b) => b.stakeMon - a.stakeMon);
  const validatorsFailed = ids.length - validatorsScanned;
  const complete = registry.complete && !registry.stale && validatorsFailed === 0;
  return {
    network, address: rawAddr, complete, partial: !complete,
    registryStale: registry.stale, registryFetchedAt: registry.fetchedAt,
    positionCount: positions.length,
    // This is an observed subtotal when complete=false, not a full portfolio.
    totalStakeMon: positions.reduce((sum, position) => sum + position.stakeMon, 0),
    validatorsTotal: ids.length, validatorsScanned, validatorsFailed,
    positions, fetchedAt: Date.now(),
    ...(ids.length > 0 && validatorsScanned === 0
      ? { error: 'No validator balances could be verified. Please retry.' } : {}),
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawAddr = (sp.get('address') ?? '').toLowerCase();
  const rawNet = sp.get('network') ?? 'testnet';
  const network: NetworkId = (rawNet === 'mainnet' ? 'mainnet' : 'testnet');

  if (!ADDRESS_RE.test(rawAddr)) {
    return NextResponse.json({ error: 'Invalid address (expected 0x + 40 hex characters).' }, { status: 400 });
  }

  if (rawNet !== 'testnet' && rawNet !== 'mainnet') {
    return NextResponse.json({ error: 'Invalid network.' }, { status: 400 });
  }
  const cacheKey = `${network}:${rawAddr}`;
  pruneCache(Date.now());
  const cached = _cache.get(cacheKey);
  if (cached) {
    const registry = getRegistryStatus(network);
    if (registry.complete && !registry.stale) {
      return NextResponse.json({ ...cached.data, cached: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    _cache.delete(cacheKey);
  }
  try {
    let pending = _inFlight.get(cacheKey);
    if (!pending) {
      if (_inFlight.size >= MAX_CONCURRENT_SCANS) {
        return NextResponse.json({ error: 'Scans are busy. Please retry shortly.' }, { status: 503 });
      }
      pending = scan(network, rawAddr);
      _inFlight.set(cacheKey, pending);
    }
    let data: Record<string, unknown>;
    try { data = await pending; }
    finally { if (_inFlight.get(cacheKey) === pending) _inFlight.delete(cacheKey); }
    // Never retain an incomplete, unavailable or warming-up portfolio as a
    // successful cached result. Concurrent same-wallet requests share work.
    if (data.complete === true && !data.error) {
      pruneCache(Date.now());
      _cache.set(cacheKey, { ts: Date.now(), data });
      pruneCache(Date.now());
    }
    return NextResponse.json(data, {
      status: data.error ? 503 : data.building ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return apiError(err, 500, 'my-delegations/scan');
  }
}
