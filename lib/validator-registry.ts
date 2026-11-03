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

export interface ChainValidatorData {
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
// Per-network directory. This was hardcoded to /testnet and used for BOTH networks, so a
// mainnet validator inherited the moniker, website, logo and X account of whichever TESTNET
// validator happened to share its numeric id — a different operator entirely. Both directories
// exist upstream (testnet 278 files, mainnet 221 as of 2026-07-31).
const GITHUB_API_BASE = 'https://api.github.com/repos/monad-developers/validator-info/contents';
function githubApiUrl(network: NetworkId): string {
  return `${GITHUB_API_BASE}/${network}`;
}

// Per-network last-fetch timestamps. Testnet and mainnet have separate
// state so a mainnet load doesn't reset the testnet TTL clock.
import type { NetworkId } from './networks';
const _lastFetch: Map<NetworkId, number> = new Map();
const _inflight = new Map<NetworkId, Promise<void>>();
interface RegistryStatus {
  complete: boolean;
  stale: boolean;
  fetchedAt: number | null;
  error: string | null;
}
const _snapshotStatus = new Map<NetworkId, { fetchedAt: number; error: string | null }>();
const _refreshErrors = new Map<NetworkId, string>();

/** Distinguishes a completed empty chain snapshot from an unavailable registry. */
export function getRegistryStatus(network: NetworkId = 'testnet'): RegistryStatus {
  const snapshot = _snapshotStatus.get(network);
  const error = _refreshErrors.get(network) ?? snapshot?.error ?? null;
  return {
    complete: !!snapshot,
    stale: !snapshot || !!error || Date.now() - snapshot.fetchedAt >= REGISTRY_TTL_MS,
    fetchedAt: snapshot?.fetchedAt ?? null,
    error,
  };
}

const REGISTRY_TTL_MS = 60 * 60_000; // 1 hour
// Backoff after a failed/empty load. Long enough that a GitHub rate-limit window (60 req/hour)
// can drain, short enough that a transient blip does not leave `validator-N` placeholders up
// for a full hour.
const REGISTRY_RETRY_MS = 5 * 60_000; // 5 minutes

async function fetchGithubValidators(network: NetworkId): Promise<GithubValidatorInfo[]> {
  // Hard timeouts so a GitHub stall doesn't pin ensureRegistryLoaded callers
  // (which propagates to /api/validators, /api/address/[address], etc.) forever.
  // List API has a 3-attempt retry with exponential backoff because rate-limit
  // races on cold-start used to leave the dashboard with `validator-N`
  // placeholder names for an entire 1-hour TTL window — bug observed 2026-05-20.
  let files: { name: string; download_url: string }[] | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(githubApiUrl(network), {
        headers: { 'User-Agent': 'monad-stats-dashboard' },
        next: { revalidate: 3600 },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // 403 (rate-limit), 5xx — retry. 404 — give up.
        if (res.status === 404) throw new Error(`GitHub API 404`);
        throw new Error(`GitHub API ${res.status}`);
      }
      files = await res.json() as { name: string; download_url: string }[];
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  if (!files) return [];

  const validators: GithubValidatorInfo[] = [];
  const batchSize = 20;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(f => fetch(f.download_url, {
        signal: AbortSignal.timeout(8_000),
      }).then(r => r.json() as Promise<GithubValidatorInfo>))
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

export function getRegistryEntries(network: NetworkId = 'testnet') {
  return getRegistrySnapshot(network);
}

// Enumerate all validator IDs directly from the staking precompile so we
// capture validators that don't have GitHub metadata (observed 269 on chain
// vs 254 in the GitHub repo as of 2026-04-22). GitHub data is joined as a
// metadata overlay — unknown IDs simply lack a moniker.
// `getConsensusValidatorSet` selector. Returns paginated tuples of
// (bool isDone, uint32 nextIndex, uint64[] valIds). One call returns up to
// 100 IDs; we paginate until isDone=true. This is the CANONICAL source of
// the active set — Monad selects top-200 staked validators per epoch via
// syscallSnapshot. Per docs.monad.xyz/reference/staking/api.
const CONSENSUS_SET_SELECTOR = '0xfb29b729';

// Per-network consensus set. Testnet has a populated active set;
// mainnet's staking precompile is currently empty.
const _consensusIdsMap: Map<NetworkId, Set<number>> = new Map();
const _consensusFetchedAtMap: Map<NetworkId, number> = new Map();

// Per-network per-ID chain data. Preserves multi-validatorId-per-authAddress
// relationships that are flattened by validator-monikers' authAddress-keyed
// Map. Operators like Category Labs run 4 IDs under one auth: aggregating
// participationPct without this map underestimates their effective stake by
// 4× and produces systematically inflated %.
const _chainByIdMap: Map<NetworkId, Map<number, ChainValidatorData>> = new Map();

export function getConsensusIds(network: NetworkId = 'testnet'): Set<number> {
  return _consensusIdsMap.get(network) ?? new Set();
}

export function getConsensusFetchedAt(network: NetworkId = 'testnet'): number {
  return _consensusFetchedAtMap.get(network) ?? 0;
}

/**
 * Per-validator-ID chain data, indexed by ID — NOT auth-deduped. Multi-ID
 * operators have multiple entries here (one per ID). Use this for any
 * stake-rollup or active-set computation; use getRegistryEntries for moniker
 * / per-row UI display.
 */
export function getChainDataById(network: NetworkId = 'testnet'): Map<number, ChainValidatorData> {
  return _chainByIdMap.get(network) ?? new Map();
}

async function fetchConsensusSet(rpcUrl: string): Promise<Set<number>> {
  const ids = new Set<number>();
  let startIndex = 0;
  // Hard cap at 5 pages = 500 IDs to avoid infinite loop on broken RPC.
  for (let page = 0; page < 5; page++) {
    const startHex = startIndex.toString(16).padStart(64, '0');
    const data = CONSENSUS_SET_SELECTOR + startHex;
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: STAKING_PRECOMPILE, data }, 'latest'],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`getConsensusValidatorSet HTTP ${res.status}`);
    const j = await res.json() as { result?: string; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    const raw = j.result ?? '';
    if (raw.length < 130) break;
    const hex = raw.slice(2);
    const isDone = parseInt(hex.slice(0, 64), 16) !== 0;
    const nextIndex = parseInt(hex.slice(64, 128), 16);
    const arrOffset = parseInt(hex.slice(128, 192), 16) * 2;
    const arrLen = parseInt(hex.slice(arrOffset, arrOffset + 64), 16);
    for (let i = 0; i < arrLen; i++) {
      const pos = arrOffset + 64 + i * 64;
      if (pos + 64 > hex.length) break;
      ids.add(parseInt(hex.slice(pos, pos + 64), 16));
    }
    if (isDone || arrLen === 0) break;
    startIndex = nextIndex;
  }
  return ids;
}

// Returns the map AND whether any batch actually failed at the transport level. The caller needs
// that distinction: "the chain has no validators" and "we could not reach the chain" produce the
// same empty map, and only the second one justifies retrying sooner than the TTL. Mainnet's
// staking precompile currently answers `method not supported`, so an empty result there is a
// legitimate answer — retrying it every few minutes would rebuild the hammer loop this file
// exists to avoid, at twelve times the hourly rate.
async function enumerateOnChain(
  rpcUrl: string,
  maxProbeId = 500,
  network: NetworkId = 'testnet',
): Promise<{ map: Map<number, ChainValidatorData>; anyBatchFailed: boolean }> {
  const result = new Map<number, ChainValidatorData>();
  let anyBatchFailed = false;
  // Public mainnet RPCs commonly cap individual methods at 25/sec, including
  // methods inside a batch. Leave room for tip, gas, and consensus requests.
  const batchSize = network === 'mainnet' ? 10 : 25;
  const pauseMs = network === 'mainnet' ? 1_000 : 800;
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, pauseMs));
  for (let off = 1; off <= maxProbeId; off += batchSize) {
    const requests = [];
    for (let id = off; id < off + batchSize && id <= maxProbeId; id++) {
      requests.push({
        jsonrpc: '2.0', id,
        method: 'eth_call',
        params: [
          { to: STAKING_PRECOMPILE, data: '0x2b6d639a' + id.toString(16).padStart(64, '0') },
          'latest',
        ],
      });
    }
    let succeeded = false;
    // One sequential retry may recover a transient response without discarding
    // the entire cold snapshot. Both retries and later batches retain pacing.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await pause();
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requests),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Validator batch HTTP ${res.status}`);
        const items = await res.json() as Array<{ id: number; result?: string; error?: { message?: string } }>;
        if (!Array.isArray(items)) throw new Error('Invalid validator batch response');
        const returnedIds = new Set(items.map(item => item.id));
        if (requests.some(request => !returnedIds.has(request.id))) {
          throw new Error('Incomplete validator batch response');
        }
        const batchResult = new Map<number, ChainValidatorData>();
        for (const it of items) {
          // Unsupported staking methods/unknown IDs may be legitimate empty
          // results; transient errors require a retry, not a zero stake.
          if (it.error && /rate|limit|timeout|temporar|internal|unavailable/i.test(it.error.message ?? '')) {
            throw new Error('Transient validator batch error');
          }
          const data = decodeValidatorResult(it.result ?? '');
          if (!data || data.authAddress === '0x0000000000000000000000000000000000000000') continue;
          batchResult.set(it.id, data);
        }
        for (const [id, data] of batchResult) result.set(id, data);
        succeeded = true;
        break;
      } catch { /* bounded retry, then mark this snapshot incomplete */ }
    }
    if (!succeeded) anyBatchFailed = true;
    await pause();
  }
  return { map: result, anyBatchFailed };
}

export function ensureRegistryLoaded(rpcUrl: string, network: NetworkId = 'testnet'): Promise<void> {
  const pending = _inflight.get(network);
  if (pending) return pending;
  const last = _lastFetch.get(network) ?? 0;
  if (Date.now() - last < REGISTRY_TTL_MS) return Promise.resolve();

  const task = refreshRegistry(rpcUrl, network).finally(() => {
    if (_inflight.get(network) === task) _inflight.delete(network);
  });
  _inflight.set(network, task);
  return task;
}

async function refreshRegistry(rpcUrl: string, network: NetworkId): Promise<void> {
  _lastFetch.set(network, Date.now());
  try {
    let consensusFailed = false;
    let githubFailed = false;
    const [chainResult, consensusIds, github] = await Promise.all([
      enumerateOnChain(rpcUrl, 800, network),
      fetchConsensusSet(rpcUrl).catch(err => {
        consensusFailed = true;
        console.error(`[registry] [${network}] Consensus refresh failed; preserving previous set:`, err);
        return getConsensusIds(network);
      }),
      fetchGithubValidators(network).catch(() => {
        githubFailed = true;
        return [] as GithubValidatorInfo[];
      }),
    ]);

    // A healthy populated consensus set must not disappear because a provider
    // starts returning an empty/unsupported payload instead of a JSON-RPC error.
    if (consensusIds.size === 0 && getConsensusIds(network).size > 0) {
      consensusFailed = true;
    }

    // A partial scan is not a new registry snapshot. Keep the last good chain
    // and metadata together; otherwise one failed batch can silently remove
    // validators and corrupt stake totals, participation, and delegator views.
    if (chainResult.anyBatchFailed) throw new Error('Incomplete validator scan');
    const chainMap = chainResult.map;
    if (chainMap.size === 0 && getChainDataById(network).size > 0) {
      throw new Error('Empty validator scan would replace a non-empty snapshot');
    }
    const previous = new Map(getRegistrySnapshot(network).map(entry => [entry.id, entry]));
    const githubById = new Map(github.map(entry => [entry.id, entry]));
    const entries = Array.from(chainMap.entries()).map(([id, chain]) => {
      // Keep known metadata when GitHub is unavailable or returns a partial list.
      const g = githubById.get(id) ?? previous.get(id);
      return {
        id,
        name: g?.name ?? `validator-${id}`,
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

    _chainByIdMap.set(network, chainMap);
    if (!consensusFailed) {
      _consensusIdsMap.set(network, consensusIds);
      _consensusFetchedAtMap.set(network, Date.now());
    }
    loadRegistry(entries, network);
    _refreshErrors.delete(network);
    _snapshotStatus.set(network, {
      fetchedAt: Date.now(),
      error: consensusFailed || githubFailed || (github.length === 0 && entries.length > 0)
        ? 'Registry metadata or consensus refresh is incomplete.' : null,
    });
    console.log(`[registry] [${network}] Loaded ${entries.length} validators on-chain (${github.length} with GitHub metadata, ${consensusIds.size} in canonical consensus set)`);

    if (consensusFailed || githubFailed || (github.length === 0 && entries.length > 0)) {
      _lastFetch.set(network, Date.now() - REGISTRY_TTL_MS + REGISTRY_RETRY_MS);
      console.warn(`[registry] [${network}] Incomplete metadata/consensus refresh; retry in ${REGISTRY_RETRY_MS / 60_000} min`);
    }
  } catch (e) {
    _refreshErrors.set(network, 'Registry refresh failed; the last complete snapshot is retained.');
    _lastFetch.set(network, Date.now() - REGISTRY_TTL_MS + REGISTRY_RETRY_MS);
    console.error(`[registry] [${network}] Refresh failed; keeping last good snapshot (retry in ${REGISTRY_RETRY_MS / 60_000} min):`, e);
  }
}
