import { NextResponse } from 'next/server';
import {
  getReorgState, getClientVersion, getGeoSummary, getSetChanges,
  fetchReorgsFromInflux, fetchSetChangesFromInflux,
} from '@/lib/networkHealth';
import { getValidatorInfo } from '@/lib/validator-monikers';

export const dynamic = 'force-dynamic';

interface ValidatorRow { address: string; moniker?: string; stakeMon?: number; }

// Nakamoto coefficient for a BFT chain. The relevant threshold for BFT
// safety/liveness is the minimum number of validators whose combined stake
// exceeds `threshold` of total. 1/3 halts liveness, 2/3 controls safety.
function nakamoto(sorted: number[], threshold: number): { n: number; cumPct: number } {
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return { n: 0, cumPct: 0 };
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i];
    if (cum > total * threshold) {
      return { n: i + 1, cumPct: (cum / total) * 100 };
    }
  }
  return { n: sorted.length, cumPct: 100 };
}

export async function GET() {
  // Fetch current validator set from our own API for stake distribution.
  // Endpoint returns `{ validators: [...] }` wrapper, not a raw array.
  const base = process.env.SELF_URL ?? 'http://127.0.0.1:3001';
  let validators: ValidatorRow[] = [];
  try {
    const r = await fetch(`${base}/api/validators`, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    if (r.ok) {
      const body = await r.json() as { validators?: ValidatorRow[] } | ValidatorRow[];
      validators = Array.isArray(body) ? body : (body.validators ?? []);
    }
  } catch { /* fall through with empty list */ }

  const stakes = validators
    .map(v => Number(v.stakeMon ?? 0))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);
  const totalStake = stakes.reduce((s, v) => s + v, 0);

  const n33 = nakamoto(stakes, 1 / 3);
  const n50 = nakamoto(stakes, 1 / 2);
  const n66 = nakamoto(stakes, 2 / 3);

  // Top-10 stake share
  const top10 = stakes.slice(0, 10);
  const top10Pct = totalStake > 0 ? (top10.reduce((s, v) => s + v, 0) / totalStake) * 100 : 0;

  // Top stakers with moniker (sorted by stake)
  const topValidators = [...validators]
    .filter(v => Number(v.stakeMon ?? 0) > 0)
    .sort((a, b) => Number(b.stakeMon ?? 0) - Number(a.stakeMon ?? 0))
    .slice(0, 10)
    .map(v => ({
      address: v.address,
      moniker: v.moniker ?? null,
      stakeMon: Number(v.stakeMon ?? 0),
      sharePct: totalStake > 0 ? (Number(v.stakeMon ?? 0) / totalStake) * 100 : 0,
    }));

  const version = await getClientVersion();
  const reorg = getReorgState();
  const geo = getGeoSummary();
  const setChanges = getSetChanges();

  // Merge in-memory reorgs with InfluxDB history. Detector ring resets on
  // PM2 restart so without this the page would render empty for the first
  // few minutes after every deploy. InfluxDB has been receiving every
  // detected reorg since the dual-write was added, so we can pull a wide
  // window cheaply (cardinality is low — typical testnet has <5 reorgs/day).
  // Window: 30d. Chose 30d after 7d showed empty for ~24h gaps between
  // reorg clusters, leaving the section looking broken when chain was just stable.
  const persistedReorgs = (await fetchReorgsFromInflux(30 * 86400)) ?? [];
  const seen = new Set(reorg.events.map(e => `${e.ts}-${e.blockNumber}`));
  const merged = [
    ...reorg.events,
    ...persistedReorgs.filter(e => !seen.has(`${e.ts}-${e.blockNumber}`)),
  ].sort((a, b) => b.ts - a.ts).slice(0, 50);
  const totalDetectedAllTime = persistedReorgs.length + reorg.events.filter(e => !persistedReorgs.some(p => p.ts === e.ts && p.blockNumber === e.blockNumber)).length;

  // Same merge pattern for validator-set changes — detector ring resets on
  // PM2 restart so without InfluxDB merge the section renders empty for the
  // first hour or two after every deploy, even though events are persisted.
  // Dedupe by (ts, address, type) since type adds disambiguation when the
  // same address has two events at the same millisecond (added + removed).
  const persistedSetChanges = (await fetchSetChangesFromInflux(30 * 86400)) ?? [];
  const setChangesKey = (e: { ts: number; address: string; type: string }) =>
    `${e.ts}-${e.address}-${e.type}`;
  const setChangesSeen = new Set(setChanges.events.map(setChangesKey));
  const mergedSetChangesRaw = [
    ...setChanges.events,
    ...persistedSetChanges.filter(e => !setChangesSeen.has(setChangesKey(e))),
  ].sort((a, b) => b.ts - a.ts);

  // Filter post-restart phantoms. When monad-stats PM2-restarts, the
  // validator-set detector's first ticks race against /api/validators
  // returning a "building" partial list — addresses that exist in prev
  // (from a fully-populated snapshot before restart) but not in curr (the
  // partial list) get falsely emitted as "removed". These phantoms are
  // identifiable by all of: type=removed AND no moniker captured AND
  // oldStake ≤ 0. Real removals carry a positive oldStake from prev.
  // Also drop "added" events whose paired "removed" was a phantom (same
  // address re-appearing seconds later when the validators list completes).
  const phantomAddresses = new Set<string>();
  for (const e of mergedSetChangesRaw) {
    if (e.type === 'removed' && !e.moniker && (e.oldStake ?? 0) <= 0) {
      phantomAddresses.add(e.address);
    }
  }
  const filtered = mergedSetChangesRaw.filter(e => {
    if (e.type === 'removed' && !e.moniker && (e.oldStake ?? 0) <= 0) return false;
    if (e.type === 'added' && phantomAddresses.has(e.address) && !e.moniker) return false;
    return true;
  });

  // Enrich monikers from the validator registry — surviving events may still
  // lack moniker if the writer captured prev snapshot before GitHub metadata
  // loaded. Read-time lookup uses the auth-address keyed registry.
  const mergedSetChanges = filtered.slice(0, 100).map(e => {
    if (e.moniker) return e;
    const info = getValidatorInfo(e.address);
    return info?.moniker ? { ...e, moniker: info.moniker } : e;
  });
  const totalSetChangesAllTime = persistedSetChanges.length
    + setChanges.events.filter(e => !persistedSetChanges.some(p => setChangesKey(p) === setChangesKey(e))).length;

  return NextResponse.json({
    fetchedAt: Date.now(),
    decentralization: {
      totalValidators: validators.length,
      activeValidators: stakes.length,
      totalStakeMon: totalStake,
      nakamoto: {
        threshold33: n33,  // min validators to halt liveness (BFT: >1/3)
        threshold50: n50,
        threshold66: n66,  // min validators to control safety (BFT: >2/3)
      },
      top10SharePct: top10Pct,
      topValidators,
    },
    clientVersion: {
      rpc: version.rpc,                // public RPC gateway version
      installed: version.installed,    // our validator's actual running binary (from otelcol metric label)
      fetchedAt: version.fetchedAt,
      latest: version.latest,
      latestUrl: version.latestUrl,
      latestFetchedAt: version.latestFetchedAt,
      isUpToDate: version.isUpToDate,
      rpcMatchesInstalled: version.rpcMatchesInstalled,
      note: '"installed" is our validator\'s actually running binary (scraped from otelcol metrics). "rpc" is the public gateway — may differ. "latest" is the GitHub release.',
    },
    reorgs: {
      recent: merged,                     // up to 50, newest first, in-memory ∪ InfluxDB
      totalDetected: totalDetectedAllTime,
      trackedBlocks: reorg.trackedBlocks,
      windowStart: merged.length ? merged[merged.length - 1].ts : null,
      historyWindowDays: 30,
      sourceNote: 'In-memory ring (since service restart) merged with persisted history from InfluxDB (last 30 days).',
    },
    geo: geo ?? {
      fetchedAt: null,
      totalPeers: 0,
      byCountry: [],
      byAsn: [],
      sampleIps: 0,
      note: 'Geo data is refreshed every 30 min from peer keepalive logs; initial refresh may still be pending.',
    },
    validatorSetChanges: {
      events: mergedSetChanges,
      tracked: setChanges.tracked,
      totalDetected: totalSetChangesAllTime,
      historyWindowDays: 30,
      note: 'Monad testnet does not expose slashing events directly. Any stake decrease ≥1000 MON or validator removal is surfaced here. In-memory ring (since service restart) merged with persisted history from InfluxDB (last 30 days).',
    },
  });
}
