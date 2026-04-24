import { loadRegistry, getRegistrySnapshot } from './validator-monikers';

interface GithubValidatorInfo {
  id: number;
  name: string;
  secp: string;
  bls?: string;
  website?: string;
  description?: string;
  logo?: string;
  x?: string;
}

interface ChainValidatorData {
  authAddress: string;
  stakeMon: number;
  commissionPct: number;
}

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const GITHUB_API = 'https://api.github.com/repos/monad-developers/validator-info/contents/testnet';

let lastFetch = 0;
const REGISTRY_TTL_MS = 60 * 60_000; // 1 hour

async function fetchGithubValidators(): Promise<GithubValidatorInfo[]> {
  const res = await fetch(GITHUB_API, {
    headers: { 'User-Agent': 'monad-stats-dashboard' },
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const files = await res.json() as { name: string; download_url: string }[];

  const validators: GithubValidatorInfo[] = [];
  const batchSize = 20;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(f => fetch(f.download_url).then(r => r.json() as Promise<GithubValidatorInfo>))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.id != null && r.value?.name) {
        validators.push(r.value);
      }
    }
  }
  return validators;
}

function decodeValidatorResult(raw: string): ChainValidatorData | null {
  if (!raw || raw.length < 130) return null;
  const slots = [];
  for (let i = 2; i + 64 <= raw.length; i += 64) {
    slots.push(raw.slice(i, i + 64));
  }
  // Slot layout on Monad testnet staking precompile (verified empirically):
  //   0 authAddress
  //   2 selfStake (validator's own tokens)
  //   4 commission (fixed-point 18 decimals)
  //   5 unclaimedRewards (small, grows between claims)
  //   8 totalStake (self + delegated) ← what gates active-set membership
  // We used to return slot 2 as `stakeMon`, which hid delegated stake and
  // made validators with delegators appear below the 10M active-set floor.
  if (slots.length < 9) return null;

  const authAddress = '0x' + slots[0].slice(24);
  const stakeWei = BigInt('0x' + slots[8]);            // total stake
  const commissionRaw = BigInt('0x' + slots[4]);

  const stakeMon = Number(stakeWei) / 1e18;
  const commissionPct = Number(commissionRaw) / 1e18 * 100;

  return { authAddress, stakeMon, commissionPct };
}

async function fetchChainData(
  validators: GithubValidatorInfo[],
  rpcUrl: string
): Promise<Map<number, ChainValidatorData>> {
  const result = new Map<number, ChainValidatorData>();
  const batchSize = 100;

  for (let i = 0; i < validators.length; i += batchSize) {
    const batch = validators.slice(i, i + batchSize);
    const requests = batch.map((v, idx) => ({
      jsonrpc: '2.0',
      id: idx,
      method: 'eth_call',
      params: [
        {
          to: STAKING_PRECOMPILE,
          data: '0x2b6d639a' + v.id.toString(16).padStart(64, '0'),
        },
        'latest',
      ],
    }));

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requests),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) continue;

    const items = await res.json() as { id: number; result?: string }[];
    for (const item of items) {
      const data = decodeValidatorResult(item.result ?? '');
      if (data) result.set(batch[item.id].id, data);
    }
  }
  return result;
}

export function getRegistryEntries() {
  return getRegistrySnapshot();
}

// Enumerate all validator IDs directly from the staking precompile so we
// capture validators that don't have GitHub metadata (observed 269 on chain
// vs 254 in the GitHub repo as of 2026-04-22). GitHub data is joined as a
// metadata overlay — unknown IDs simply lack a moniker.
async function enumerateOnChain(rpcUrl: string, maxProbeId = 500): Promise<Map<number, ChainValidatorData>> {
  const result = new Map<number, ChainValidatorData>();
  const BATCH = 50;
  for (let off = 1; off <= maxProbeId; off += BATCH) {
    const requests = [];
    for (let id = off; id < off + BATCH && id <= maxProbeId; id++) {
      requests.push({
        jsonrpc: '2.0', id,
        method: 'eth_call',
        params: [
          { to: STAKING_PRECOMPILE, data: '0x2b6d639a' + id.toString(16).padStart(64, '0') },
          'latest',
        ],
      });
    }
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const items = await res.json() as Array<{ id: number; result?: string }>;
      for (const it of items) {
        const data = decodeValidatorResult(it.result ?? '');
        if (!data) continue;
        if (data.authAddress === '0x0000000000000000000000000000000000000000') continue;
        result.set(it.id, data);
      }
    } catch { /* retry next batch */ }
    // Stay under RPC rate limits
    await new Promise(r => setTimeout(r, 800));
  }
  return result;
}

export async function ensureRegistryLoaded(rpcUrl: string): Promise<void> {
  if (Date.now() - lastFetch < REGISTRY_TTL_MS) return;
  lastFetch = Date.now();

  try {
    // Primary source: enumerate the staking precompile directly.
    // Secondary: GitHub monikers/websites keyed by same validator ID.
    const [chainMap, github] = await Promise.all([
      enumerateOnChain(rpcUrl, 800),
      fetchGithubValidators().catch(() => [] as GithubValidatorInfo[]),
    ]);
    const githubById = new Map<number, GithubValidatorInfo>();
    for (const g of github) githubById.set(g.id, g);

    const entries = Array.from(chainMap.entries()).map(([id, chain]) => {
      const g = githubById.get(id);
      return {
        id,
        name: g?.name ?? `validator-${id}`,   // fallback when GitHub has no moniker
        authAddress: chain.authAddress.toLowerCase(),
        secp: g?.secp ?? '',
        website: g?.website,
        description: g?.description,
        logo: g?.logo,
        x: g?.x,
        stakeMon: chain.stakeMon,
        commissionPct: chain.commissionPct,
      };
    });

    loadRegistry(entries);
    // eslint-disable-next-line no-console
    console.log(`[registry] Loaded ${entries.length} validators on-chain (${github.length} with GitHub metadata)`);
  } catch (e) {
    lastFetch = 0;
    console.error('[registry] Failed to load:', e);
  }
}
