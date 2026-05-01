import { NextResponse } from 'next/server';
import {
  getReorgState, getClientVersion, getGeoSummary, getSetChanges,
  fetchReorgsFromInflux,
} from '@/lib/networkHealth';

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
  const persistedReorgs = (await fetchReorgsFromInflux(7 * 86400)) ?? [];
  const seen = new Set(reorg.events.map(e => `${e.ts}-${e.blockNumber}`));
  const merged = [
    ...reorg.events,
    ...persistedReorgs.filter(e => !seen.has(`${e.ts}-${e.blockNumber}`)),
  ].sort((a, b) => b.ts - a.ts).slice(0, 50);
  const totalDetectedAllTime = persistedReorgs.length + reorg.events.filter(e => !persistedReorgs.some(p => p.ts === e.ts && p.blockNumber === e.blockNumber)).length;

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
      historyWindowDays: 7,
      sourceNote: 'In-memory ring (since service restart) merged with persisted history from InfluxDB (last 7 days).',
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
      events: setChanges.events,
      tracked: setChanges.tracked,
      note: 'Monad testnet does not expose slashing events directly. Any stake decrease ≥1000 MON or validator removal is surfaced here.',
    },
  });
}
