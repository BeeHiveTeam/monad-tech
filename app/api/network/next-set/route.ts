import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiError';
import { ensureRegistryLoaded, getChainDataById, getConsensusIds } from '@/lib/validator-registry';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

// 60s cache — snapshotStake only updates at epoch boundaries (~5.5h on testnet
// with 50k blocks per epoch × 0.4s blocks), so refreshing more often is waste.
const CACHE_TTL = 60_000;
const cache = new Map<string, { ts: number; data: unknown }>();

const STAKE_MOVE_THRESHOLD_MON = 100_000;   // surface moves ≥100K MON
const STAKE_MOVE_THRESHOLD_PCT = 5;         // OR ≥5% of own snapshotStake

interface SetMember {
  validatorId: number;
  authAddress: string;
  moniker: string | null;
  snapshotStakeMon: number;
  activeStakeMon: number;
  consensusStakeMon: number;
  deltaMon: number;          // activeStake − snapshotStake (what will move into next snapshot)
  deltaPct: number;           // delta as % of snapshotStake
}

async function getLatestBlock(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: string };
    return j.result ? parseInt(j.result, 16) : null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const rawNet = req.nextUrl.searchParams.get('network') ?? 'testnet';
  const network: NetworkId = (rawNet === 'mainnet' ? 'mainnet' : 'testnet');

  const cached = cache.get(network);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
      ? process.env.MONAD_RPC_URL
      : NETWORKS[network].rpc;
    await ensureRegistryLoaded(rpcUrl, network);

    const chainData = getChainDataById(network);
    const consensusIds = getConsensusIds(network);

    if (chainData.size === 0) {
      return NextResponse.json({
        network, building: true,
        message: 'Registry is still loading.',
        fetchedAt: Date.now(),
      });
    }

    // Build per-ID enriched rows.
    const allRows: SetMember[] = [];
    for (const [id, data] of chainData) {
      const snapshotStake = data.stakeMon ?? 0;
      const activeStake = data.activeStakeMon ?? snapshotStake;
      const consensusStake = data.consensusStakeMon ?? snapshotStake;
      const deltaMon = activeStake - snapshotStake;
      const deltaPct = snapshotStake > 0 ? (deltaMon / snapshotStake) * 100 : 0;
      const info = getValidatorInfo(data.authAddress, network);
      allRows.push({
        validatorId: id,
        authAddress: data.authAddress,
        moniker: info?.moniker ?? null,
        snapshotStakeMon: snapshotStake,
        activeStakeMon: activeStake,
        consensusStakeMon: consensusStake,
        deltaMon,
        deltaPct,
      });
    }

    // Projected next active set: top-N by snapshotStake, where N = current
    // consensus set size. Require canonical consensusIds — the prior fallback
    // mixed "top-200 by stake" (projected) with "≥10M stake" (current),
    // polluting joining/leaving with garbage rows when consensusIds was empty
    // (e.g. mainnet today — getConsensusValidatorSet returns nothing). Return
    // building=true instead of guessing. Audit-pass H2.
    if (consensusIds.size === 0) {
      return NextResponse.json({
        network,
        building: true,
        message: 'Canonical consensus set not yet available on this network. Projection requires getConsensusValidatorSet to return non-empty.',
        fetchedAt: Date.now(),
      });
    }
    const currentSetSize = consensusIds.size;
    const projectedNextSet = [...allRows]
      .sort((a, b) => b.snapshotStakeMon - a.snapshotStakeMon)
      .slice(0, currentSetSize);
    const projectedIds = new Set(projectedNextSet.map(r => r.validatorId));
    const currentIds = consensusIds;

    // Joining: in projected but NOT in current consensus.
    const joining = projectedNextSet
      .filter(r => !currentIds.has(r.validatorId))
      .sort((a, b) => b.snapshotStakeMon - a.snapshotStakeMon);

    // Leaving: in current consensus but NOT in projected next set.
    const leaving = allRows
      .filter(r => currentIds.has(r.validatorId) && !projectedIds.has(r.validatorId))
      .sort((a, b) => b.snapshotStakeMon - a.snapshotStakeMon);

    // Stake movers: REAL delegate/undelegate flow only. Audit 2026-05-20 found
    // that without the (snap>0 AND active>0) gate, this table fills with 30
    // epoch-rotation crossings (snap=0, active=11M) — already shown in the
    // Leaving list above + filtered as artifacts in Validator Set Changes.
    // Now requires both stakes positive (= real delegation movement that
    // doesn't simultaneously cross an active-set boundary).
    const movers = allRows
      .filter(r => {
        if (r.snapshotStakeMon <= 0 || r.activeStakeMon <= 0) return false;
        return Math.abs(r.deltaMon) >= STAKE_MOVE_THRESHOLD_MON
            || Math.abs(r.deltaPct) >= STAKE_MOVE_THRESHOLD_PCT;
      })
      .sort((a, b) => Math.abs(b.deltaMon) - Math.abs(a.deltaMon))
      .slice(0, 30);

    // Epoch position — same math as /api/stats so the widget aligns.
    const blocksPerEpoch = NETWORKS[network].blocksPerEpoch;
    const latestBlockNum = await getLatestBlock(rpcUrl);

    const epochInfo = latestBlockNum
      ? {
          currentEpoch: Math.floor(latestBlockNum / blocksPerEpoch) + 1,
          blockInEpoch: latestBlockNum % blocksPerEpoch,
          blocksPerEpoch,
          blocksUntilNext: blocksPerEpoch - (latestBlockNum % blocksPerEpoch),
          progressPct: Math.round(((latestBlockNum % blocksPerEpoch) / blocksPerEpoch) * 1000) / 10,
        }
      : null;

    // Lifecycle phase derivation. Snapshot happens at epoch boundary; pre-snapshot
    // window flagged at ≥90% so operators see a "freeze" zone. Post-rotation
    // window is the first 5% of a new epoch when the new set just took over.
    const phase = (() => {
      if (!epochInfo) return 'unknown' as const;
      const p = epochInfo.progressPct;
      if (p < 5)  return 'post-rotation' as const;
      if (p < 90) return 'active' as const;
      return 'pre-snapshot' as const;
    })();

    const data = {
      network,
      fetchedAt: Date.now(),
      epoch: epochInfo,
      phase,
      currentSetSize,
      projectedSetSize: projectedNextSet.length,
      joining,
      leaving,
      movers,
      thresholds: {
        moveMon: STAKE_MOVE_THRESHOLD_MON,
        movePct: STAKE_MOVE_THRESHOLD_PCT,
      },
    };

    cache.set(network, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err, 500, 'network/next-set');
  }
}
