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
  /** Snapshot stake (MON) — gates active-set membership at epoch boundary. Slot 8. */
  stakeMon: number;
  /** Active commission % (slot 4 ÷ 1e18 × 100). */
  commissionPct: number;
  /** Live active stake (MON). May differ from snapshot mid-epoch. Slot 2. */
  activeStakeMon?: number;
  /** Consensus stake (MON) — current consensus weight. Slot 6. */
  consensusStakeMon?: number;
  /** Flags bitfield from precompile. Slot 1. */
  flags?: number;
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
  // Tuple layout per docs.monad.xyz/reference/staking/api `getValidator(uint64)`:
  //   0 authAddress
  //   1 flags (bitfield)
  //   2 stake               — live/active stake (changes with delegate/undelegate)
  //   3 accRewardPerToken
  //   4 commission           — fixed-point 18 decimals → percent
  //   5 unclaimedRewards
  //   6 consensusStake       — current consensus weight
  //   7 consensusCommission
  //   8 snapshotStake        — at last epoch snapshot, GATES active-set membership
  //   9 snapshotCommission
  //   10 secpPubkey (offset)
  //   11 blsPubkey (offset)
  //
  // We display `snapshotStake` (slot 8) as the validator's stake because it's
  // the value used to determine active-set membership at epoch boundary. The
  // older comment called this "totalStake (self + delegated)" — that name was
  // misleading; semantically the value is correct for our use case.
  if (slots.length < 10) return null;

  const authAddress = '0x' + slots[0].slice(24);
  const flags = Number(BigInt('0x' + slots[1]));
  const activeStakeWei = BigInt('0x' + slots[2]);
  const commissionRaw = BigInt('0x' + slots[4]);
  const consensusStakeWei = BigInt('0x' + slots[6]);
  const snapshotStakeWei = BigInt('0x' + slots[8]);

  return {
    authAddress,
    stakeMon: Number(snapshotStakeWei) / 1e18,        // primary "stake" displayed
    commissionPct: Number(commissionRaw) / 1e18 * 100,
    activeStakeMon: Number(activeStakeWei) / 1e18,
    consensusStakeMon: Number(consensusStakeWei) / 1e18,
    flags,
  };
}

async function fetchChainData(
  validators: GithubValidatorInfo[],
  rpcUrl: string
): Promise<Map<number, ChainValidatorData>> {
  const result = new Map<number, ChainValidatorData>();
  // batchSize 100→25 to stay under [[monad-rpc-pacing]] hard rule. eth_call to
  // the staking precompile probably uses a different internal path than
  // eth_getBlockByNumber (it doesn't go through MonadDb state lookups), but
  // we keep batch=25 for consistency with the rule until empirically proven
  // safe at higher sizes.
  const batchSize = 25;

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
  // BATCH 50→25 to align with [[monad-rpc-pacing]] hard rule (cap at 25).
  // 500/25 = 20 batches × 800ms pause = ~16s. Runs once per hour
  // (REGISTRY_TTL_MS), no UX impact.
  const BATCH = 25;
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
