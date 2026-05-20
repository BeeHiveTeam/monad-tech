import { NextResponse } from 'next/server';
import {
  getReorgState, getClientVersion, getGeoSummary, getSetChanges,
  fetchReorgsFromInflux, fetchSetChangesFromInflux,
  isSnapshotRotationArtifact,
} from '@/lib/networkHealth';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getChainDataById, getConsensusIds } from '@/lib/validator-registry';
import { operatorRollup, nakamotoCoefficient } from '@/lib/concentration';
import { NETWORKS } from '@/lib/networks';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Source stake-distribution data DIRECTLY from the registry so we share the
  // canonical operator-rollup math with /api/network/concentration. Pre-fix
  // [[feedback_nakamoto_two_denominators]]: network-health computed Nakamoto
  // inline over 281 validator IDs (auth-deduped) including inactive registered
  // stake, while concentration computed it over 195 operators in the canonical
  // consensus set. Two cards on two pages displayed different numbers for the
  // same metric. Now both call operatorRollup/nakamotoCoefficient from lib/concentration.ts.
  const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS['testnet'].rpc;
  await ensureRegistryLoaded(rpcUrl, 'testnet');
  const chainData = getChainDataById('testnet');
  const consensusIds = getConsensusIds('testnet');

  const { operators, totalStake } = operatorRollup(
    chainData,
    consensusIds,
    (addr) => getValidatorInfo(addr, 'testnet')?.moniker ?? null,
  );
  const stakes = operators.map(o => o.stakeMon).sort((a, b) => b - a);

  const n33 = nakamotoCoefficient(stakes, 1 / 3);
  const n50 = nakamotoCoefficient(stakes, 1 / 2);
  const n66 = nakamotoCoefficient(stakes, 2 / 3);

  // Top-10 stake share (now operator-based, not validator-ID-based)
  const top10 = stakes.slice(0, 10);
  const top10Pct = totalStake > 0 ? (top10.reduce((s, v) => s + v, 0) / totalStake) * 100 : 0;

  // Top stakers with moniker — direct from operatorRollup output, no second sort
  const topValidators = operators.slice(0, 10).map(op => ({
    address: op.authAddress,
    moniker: op.moniker,
    stakeMon: op.stakeMon,
    sharePct: op.sharePct,
  }));

  // Snapshot of the validators list size for the existing fields below.
  const activeOperatorCount = operators.length;
  const totalChainIds = chainData.size;

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
  // Audit-pass 2026-05-20 found 95% of `stake_decrease` events are epoch-rotation
  // artifacts (delta ≈ -11M = canonical Tier-4 stake of operators rotating
  // out of the 200-slot active set), not real undelegations. Filter them
  // here so the "real" 30-day undelegation log is signal, not noise.
  // See [[snapshot-rotation-noise-filter]] memory + isSnapshotRotationArtifact()
  // in lib/networkHealth.ts.
  const phantomFiltered = mergedSetChangesRaw.filter(e => {
    if (e.type === 'removed' && !e.moniker && (e.oldStake ?? 0) <= 0) return false;
    if (e.type === 'added' && phantomAddresses.has(e.address) && !e.moniker) return false;
    return true;
  });
  const rotationCount = phantomFiltered.filter(isSnapshotRotationArtifact).length;
  const filtered = phantomFiltered.filter(e => !isSnapshotRotationArtifact(e));

  // Enrich monikers from the validator registry — surviving events may still
  // lack moniker if the writer captured prev snapshot before GitHub metadata
  // loaded. Read-time lookup uses the auth-address keyed registry.
  const mergedSetChanges = filtered.slice(0, 100).map(e => {
    if (e.moniker) return e;
    const info = getValidatorInfo(e.address);
    return info?.moniker ? { ...e, moniker: info.moniker } : e;
  });
  const totalSetChangesAllTime = filtered.length;
  const totalRawSetChanges = phantomFiltered.length;

  return NextResponse.json({
    fetchedAt: Date.now(),
    decentralization: {
      // `totalValidators` = all registered chain-data IDs (active + inactive).
      // `activeValidators` = distinct OPERATORS in the canonical consensus set
      // (operator-rolled, not raw ID count). Matches /api/network/concentration.
      totalValidators: totalChainIds,
      activeValidators: activeOperatorCount,
      totalStakeMon: totalStake,
      nakamoto: {
        // Operator-based; matches /api/network/concentration exactly.
        // Min operators to halt liveness (>1/3) / control safety (>2/3).
        threshold33: n33,
        threshold50: n50,
        threshold66: n66,
      },
      top10SharePct: top10Pct,
      topValidators,
      methodologyNote: 'Operator-based metrics: validator IDs sharing an authAddress are rolled up into a single operator. Stake counted only for IDs in the canonical consensus set (snapshotStake-gated active set).',
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
      totalDetected: totalSetChangesAllTime,                 // post-filter (real undelegations)
      totalIncludingRotation: totalRawSetChanges,            // pre-filter (rotation + real)
      rotationFiltered: rotationCount,                       // number of artifact events suppressed
      historyWindowDays: 30,
      note: `Real undelegations + additions only. Snapshot-rotation artifacts (delta ≈ -11M MON, normal protocol behaviour when operators rotate out of the 200-slot active set) are filtered: ${rotationCount} suppressed of ${totalRawSetChanges} raw events in the 30-day window.`,
    },
  });
}
