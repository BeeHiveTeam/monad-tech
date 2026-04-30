import { NextRequest, NextResponse } from 'next/server';
import { rpcBatch } from '@/lib/rpc';
import { ensureRegistryLoaded, getRegistryEntries } from '@/lib/validator-registry';
import { getValidatorInfo } from '@/lib/validator-monikers';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const SEL_GET_DELEGATORS = '0xa0843a26'; // getDelegators(uint64,address)
const SEL_GET_DELEGATOR  = '0x573c1ce0'; // getDelegator(uint64,address)
const RPC_BATCH_SIZE = 25;
const MAX_PAGES = 5;        // 100 addrs/page * 5 = 500 max
const MAX_STAKE_FETCH = 200;

function pad32(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

function encGetDelegators(valId: number, startAfter: string): string {
  return SEL_GET_DELEGATORS + pad32(valId.toString(16)) + pad32(startAfter.replace(/^0x/, ''));
}

function encGetDelegator(valId: number, addr: string): string {
  return SEL_GET_DELEGATOR + pad32(valId.toString(16)) + pad32(addr.replace(/^0x/, ''));
}

interface DelegatorsPage { isDone: boolean; addresses: string[]; }

function decodeDelegatorsPage(raw: string): DelegatorsPage | null {
  if (!raw || raw.length < 130) return null;
  const hex = raw.slice(2);
  const isDone = parseInt(hex.slice(0, 64), 16) === 1;
  const arrOffset = parseInt(hex.slice(128, 192), 16) * 2;
  const arrLen = parseInt(hex.slice(arrOffset, arrOffset + 64), 16);
  const addresses: string[] = [];
  for (let i = 0; i < arrLen; i++) {
    const start = arrOffset + 64 + i * 64;
    addresses.push('0x' + hex.slice(start, start + 64).slice(24));
  }
  return { isDone, addresses };
}

function decodeDelegatorStake(raw: string): number | null {
  if (!raw || raw.length < 66) return null;
  try {
    return Number(BigInt('0x' + raw.slice(2, 66))) / 1e18;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');
  const addrParam = url.searchParams.get('address');

  let validatorId: number | null = null;
  let resolvedAddress: string | null = null;
  let moniker: string | null = null;

  await ensureRegistryLoaded(process.env.MONAD_RPC_URL || 'http://15.235.117.52:8080');

  if (idParam) {
    validatorId = parseInt(idParam, 10);
    if (!Number.isFinite(validatorId) || validatorId <= 0) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    const entry = getRegistryEntries().find(e => e.id === validatorId);
    if (entry) { resolvedAddress = entry.authAddress; moniker = entry.name; }
  } else if (addrParam) {
    const lc = addrParam.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lc)) {
      return NextResponse.json({ error: 'invalid address' }, { status: 400 });
    }
    const info = getValidatorInfo(lc);
    if (!info?.validatorId) {
      return NextResponse.json({ error: 'address not in registry', address: lc }, { status: 404 });
    }
    validatorId = info.validatorId;
    resolvedAddress = lc;
    moniker = info.moniker;
  } else {
    return NextResponse.json({ error: 'pass ?id=N or ?address=0x...' }, { status: 400 });
  }

  // Paginate getDelegators
  const allAddrs: string[] = [];
  let cursor = '0x0000000000000000000000000000000000000000';
  let pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    const results = await rpcBatch('testnet', [{
      method: 'eth_call',
      params: [{ to: STAKING_PRECOMPILE, data: encGetDelegators(validatorId, cursor) }, 'latest'],
    }]);
    const page = decodeDelegatorsPage(results[0] as string ?? '');
    if (!page) break;
    for (const a of page.addresses) {
      if (!allAddrs.includes(a)) allAddrs.push(a);
    }
    if (page.isDone) { pages += 1; break; }
    if (page.addresses.length === 0) break;
    cursor = page.addresses[page.addresses.length - 1];
  }

  const truncated = allAddrs.length > MAX_STAKE_FETCH;
  const fetchAddrs = allAddrs.slice(0, MAX_STAKE_FETCH);

  // Fetch stake per delegator (batched ≤25)
  const stakes = new Map<string, number>();
  for (let i = 0; i < fetchAddrs.length; i += RPC_BATCH_SIZE) {
    const slice = fetchAddrs.slice(i, i + RPC_BATCH_SIZE);
    const results = await rpcBatch('testnet', slice.map(addr => ({
      method: 'eth_call',
      params: [{ to: STAKING_PRECOMPILE, data: encGetDelegator(validatorId!, addr) }, 'latest'],
    })));
    results.forEach((r, k) => {
      const stake = decodeDelegatorStake(r as string);
      if (stake !== null) stakes.set(slice[k], stake);
    });
  }

  const delegators = fetchAddrs
    .map(addr => ({ address: addr, stakeMon: stakes.get(addr) ?? 0 }))
    .filter(d => d.stakeMon > 0)
    .sort((a, b) => b.stakeMon - a.stakeMon);

  const totalStakeMon = delegators.reduce((sum, d) => sum + d.stakeMon, 0);

  return new NextResponse(JSON.stringify({
    validatorId,
    address: resolvedAddress,
    moniker,
    delegatorCount: delegators.length,
    totalStakeMon,
    truncated,
    delegators,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
