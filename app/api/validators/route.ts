import { NextRequest, NextResponse } from 'next/server';
import { getLatestBlocksBatched } from '@/lib/rpc';
import { NETWORKS, NetworkId } from '@/lib/networks';
import { getMoniker, getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getRegistryEntries } from '@/lib/validator-registry';
import { setBlockCache } from '@/lib/block-cache';

export const dynamic = 'force-dynamic';

// 5000 blocks @ ~0.5s block time covers ~40 minutes of history —
// enough to surface validators that take their turn as leader across a full rotation.
const FRESH_TTL_MS = 5 * 60_000;   // serve cache fresh for 5 min
const STALE_TTL_MS = 20 * 60_000;  // then serve stale while revalidating in background
const SAMPLE_BLOCKS = 5000;

interface CacheEntry {
  ts: number;
  data: unknown;
}
const cache = new Map<NetworkId, CacheEntry>();
const refreshing = new Map<NetworkId, boolean>();

async function computeValidators(network: NetworkId) {
  const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS[network].rpc;
  await ensureRegistryLoaded(rpcUrl);

  const blocks = await getLatestBlocksBatched(network, SAMPLE_BLOCKS, false, 40, 1100);
  setBlockCache(network, blocks as Parameters<typeof setBlockCache>[1]);

  const stats = new Map<string, {
    address: string;
    blocksProduced: number;
    totalTxs: number;
    lastBlockNumber: number;
    lastBlockTs: number;
    firstBlockNumber: number;   // earliest block by this validator in the sample
    firstBlockTs: number;
  }>();

  for (const block of blocks as {
    miner: string;
    number: string;
    timestamp: string;
    transactions?: unknown[];
  }[]) {
    if (!block?.miner) continue;
    const addr = block.miner.toLowerCase();
    if (addr === '0x0000000000000000000000000000000000000000') continue;
    const entry = stats.get(addr) ?? {
      address: addr,
      blocksProduced: 0,
      totalTxs: 0,
      lastBlockNumber: 0,
      lastBlockTs: 0,
      firstBlockNumber: 0,
      firstBlockTs: 0,
    };
    entry.blocksProduced++;
    entry.totalTxs += Array.isArray(block.transactions) ? block.transactions.length : 0;
    const blockNum = parseInt(block.number, 16);
    const blockTs = parseInt(block.timestamp, 16);
    if (blockNum > entry.lastBlockNumber) {
      entry.lastBlockNumber = blockNum;
      entry.lastBlockTs = blockTs;
    }
    if (entry.firstBlockNumber === 0 || blockNum < entry.firstBlockNumber) {
      entry.firstBlockNumber = blockNum;
      entry.firstBlockTs = blockTs;
    }
    stats.set(addr, entry);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const newestTs = (blocks as { timestamp: string }[])
    .reduce((m, b) => Math.max(m, parseInt(b.timestamp, 16)), 0);
  const oldestTs = (blocks as { timestamp: string }[])
    .reduce((m, b) => (m === 0 ? parseInt(b.timestamp, 16) : Math.min(m, parseInt(b.timestamp, 16))), 0);
  const windowSeconds = Math.max(1, newestTs - oldestTs);

  const numValidators = stats.size;
  const expectedBlocks = numValidators > 0 ? blocks.length / numValidators : 0;
  const expectedGap = numValidators > 0 ? (windowSeconds / blocks.length) * numValidators : 60;

  // Threshold for detecting "new" validators: if their first block in the
  // sample is more than 2 expected gaps after the window start, they likely
  // weren't active for the whole window.
  const NEW_DETECT_THRESHOLD = expectedGap * 2;

  // Seed stats map with every on-chain validator from the registry, so that
  // validators who haven't produced blocks in the sample window still appear
  // (with zero blocks → health=missing). Without this we only see miners.
  for (const info of getRegistryEntries()) {
    const addr = info.authAddress.toLowerCase();
    if (!addr || addr === '0x0000000000000000000000000000000000000000') continue;
    if (!stats.has(addr)) {
      stats.set(addr, {
        address: addr,
        blocksProduced: 0,
        totalTxs: 0,
        lastBlockNumber: 0,
        lastBlockTs: 0,
        firstBlockNumber: 0,
        firstBlockTs: 0,
      });
    }
  }

  const validators = Array.from(stats.values())
    .map(v => {
      const ageSeconds = Math.max(0, nowSec - v.lastBlockTs);

      // Participation = produced / expected-within-active-window.
      // Active window = from first observed block (or window start if earlier)
      // to newest window edge. For validators present since the start, this
      // reduces to the old formula. For new ones, denominator is reduced
      // proportionally so they aren't penalised for not existing yet.
      const isNewInWindow = v.firstBlockTs > oldestTs + NEW_DETECT_THRESHOLD;
      const activeWindowStart = isNewInWindow ? v.firstBlockTs : oldestTs;
      // Pad the active window by one expected-gap to account for the fact
      // that a validator's "active" status starts slightly before its first
      // observed block (registration, warmup, etc.).
      const activeWindowSec = Math.max(
        expectedGap * 3,                           // minimum denominator — avoid divide-by-near-zero for very new validators
        newestTs - activeWindowStart + expectedGap,
      );
      const activeRatio = windowSeconds > 0 ? activeWindowSec / windowSeconds : 1;
      const adjustedExpected = expectedBlocks * Math.min(activeRatio, 1);

      const participationPct = adjustedExpected > 0
        ? Math.round((v.blocksProduced / adjustedExpected) * 1000) / 10
        : 0;

      let health: 'active' | 'slow' | 'missing';
      if (ageSeconds < expectedGap * 2) health = 'active';
      else if (ageSeconds < expectedGap * 5) health = 'slow';
      else health = 'missing';

      const info = getValidatorInfo(v.address);
      return {
        ...v,
        moniker: info?.moniker ?? null,
        stakeMon: info?.stakeMon ?? null,
        commissionPct: info?.commissionPct ?? null,
        // `registered` = the miner address matches an on-chain authAddress
        // in the staking precompile. Non-matched block producers are active
        // operators with separate signing keys; their stake is real but we
        // can't resolve it without a miner→validator-id lookup.
        registered: info != null,
        sharePct: Math.round((v.blocksProduced / blocks.length) * 1000) / 10,
        ageSeconds,
        participationPct,
        health,
        isNewInWindow,                              // flag for UI if caller wants to display "new" badge
        activeWindowSeconds: Math.round(activeWindowSec),
      };
    })
    .sort((a, b) => b.blocksProduced - a.blocksProduced);

  return {
    network,
    sampleSize: blocks.length,
    totalValidators: validators.length,
    windowSeconds,
    expectedGapSeconds: Math.round(expectedGap * 10) / 10,
    updatedAt: Date.now(),
    validators,
  };
}

function refreshInBackground(network: NetworkId) {
  if (refreshing.get(network)) return;
  refreshing.set(network, true);
  computeValidators(network)
    .then(data => { cache.set(network, { ts: Date.now(), data }); })
    .catch(err => { console.error('[validators] background refresh failed:', err); })
    .finally(() => { refreshing.set(network, false); });
}

// Warm up cache on server start
refreshInBackground('testnet');

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) {
    return NextResponse.json({ error: 'Invalid network' }, { status: 400 });
  }
  const network = raw as NetworkId;

  const cached = cache.get(network);
  const age = cached ? Date.now() - cached.ts : Infinity;

  if (cached && age < FRESH_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  // Kick off a refresh in background regardless; serve whatever we have.
  refreshInBackground(network);

  if (cached) {
    // Serve stale copy while refresh runs.
    return NextResponse.json({
      ...(cached.data as object),
      stale: age >= FRESH_TTL_MS,
      ageSeconds: Math.floor(age / 1000),
    });
  }

  // No cache at all — tell client we're building. Client retries on interval.
  return NextResponse.json({
    network,
    building: true,
    message: 'Collecting validator sample (5000 blocks, ~2-3 min on cold start)…',
    validators: [],
    totalValidators: 0,
    sampleSize: 0,
    windowSeconds: 0,
    expectedGapSeconds: 0,
    updatedAt: Date.now(),
  }, { status: 202 });
}
