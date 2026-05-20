import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiError';
import { ensureRegistryLoaded, getChainDataById, getConsensusIds } from '@/lib/validator-registry';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { NETWORKS, NetworkId } from '@/lib/networks';
import {
  nakamotoCoefficient,
  giniCoefficient,
  operatorRollup,
  lorenzCurve,
} from '@/lib/concentration';

export const dynamic = 'force-dynamic';

// 60s cache — concentration moves slowly; the staking precompile is the
// bottleneck and pacing rules forbid hammering it.
const CACHE_TTL = 60_000;
const cache = new Map<string, { ts: number; data: unknown }>();

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
        network,
        building: true,
        message: 'Validator registry is still loading.',
        fetchedAt: Date.now(),
      });
    }

    const { operators, totalStake } = operatorRollup(
      chainData,
      consensusIds,
      (addr) => getValidatorInfo(addr, network)?.moniker ?? null,
    );

    const stakes = operators.map(o => o.stakeMon);
    const stakesDesc = [...stakes].sort((a, b) => b - a);

    const n33 = nakamotoCoefficient(stakesDesc, 1 / 3);
    const n50 = nakamotoCoefficient(stakesDesc, 1 / 2);
    const n66 = nakamotoCoefficient(stakesDesc, 2 / 3);
    const gini = giniCoefficient(stakes);
    const lorenz = lorenzCurve(operators);

    // Cumulative curve for the descending rank-order pie/area chart.
    const cumulativeByRank = operators.map((op, i) => ({
      rank: i + 1,
      moniker: op.moniker,
      sharePct: op.sharePct,
      cumulativeSharePct: op.cumulativeSharePct,
    }));

    // Multi-ID operator surfacing — Category Labs running 4 IDs under one
    // auth is the canonical example. This is the data signal the audit-trail
    // PR exposed individually; here we aggregate.
    const multiIdOperators = operators
      .filter(op => op.validatorIds.length > 1)
      .map(op => ({
        authAddress: op.authAddress,
        moniker: op.moniker,
        validatorIds: op.validatorIds,
        stakeMon: op.stakeMon,
        sharePct: op.sharePct,
      }));

    // Top-20 for the table view.
    const top20 = operators.slice(0, 20);

    // Validator-ID-count vs operator-count (the "real" decentralization
    // distinction: 198 validator IDs ≠ 198 operators if some auth controls 4 IDs).
    const validatorIdCount = [...chainData.entries()]
      .filter(([id]) => consensusIds.size === 0 || consensusIds.has(id))
      .length;
    const operatorCount = operators.length;

    const data = {
      network,
      fetchedAt: Date.now(),
      summary: {
        validatorIdCount,
        operatorCount,
        totalStakeMon: totalStake,
        idsPerOperatorAvg: operatorCount > 0 ? Math.round((validatorIdCount / operatorCount) * 100) / 100 : 0,
      },
      nakamoto: {
        threshold33: n33,
        threshold50: n50,
        threshold66: n66,
      },
      gini: Math.round(gini * 1000) / 1000,
      multiIdOperators,
      top20,
      cumulativeByRank,
      lorenz,
      geoNote: 'Per-validator IP / AS / hosting-provider data is being integrated via Decentra.cloud (mainnet) and Monval (testnet) — coming soon.',
    };

    cache.set(network, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err, 500, 'network/concentration');
  }
}
