import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiError';
import { getGasPrice, getLatestBlocksBatched } from '@/lib/rpc';
import { getTipNumber } from '@/lib/tipCache';
import { computeChainStats, SampledBlock } from '@/lib/chainStats';
import { getEpochState } from '@/lib/epochState';
import { NETWORKS, NetworkId } from '@/lib/networks';
import {
  getLatestBlocks as getRingBlocks,
  getTipNumber as getRingTip,
} from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

function parseNetwork(req: NextRequest): NetworkId | null {
  const raw = req.nextUrl.searchParams.get('network') || 'testnet';
  if (!(raw in NETWORKS) || !NETWORKS[raw as NetworkId].active) return null;
  return raw as NetworkId;
}

async function influxWrite(lines: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // non-critical
  }
}

export async function GET(req: NextRequest) {
  const network = parseNetwork(req);
  if (!network) return NextResponse.json({ error: 'Invalid network' }, { status: 400 });

  try {
    // Primary path: tip + 10 most-recent blocks from the WebSocket ring.
    // Zero RPC at request time — ring is filled by background newHeads subscription.
    // Fallback to RPC batch if ring is cold (early after PM2 restart).
    let recent: SampledBlock[] = [];
    let latestBlockNum = 0;
    let latestBlockTs = 0;
    let txInLatest: number | null = null;
    let ringSource = false;

    // The ring buffer is filled by our testnet WS subscription only —
    // bypass it for mainnet (we'd serve testnet data otherwise).
    const ring = network === 'testnet' ? getRingBlocks(60) : [];
    const ringTip = network === 'testnet' ? getRingTip() : null;
    if (ring.length >= 2 && ringTip) {
      recent = ring.map(b => ({
        number: b.number,
        ts: b.timestamp,
        txCount: b.txCount,
        gasUsed: b.gasUsed,
        gasLimit: b.gasLimit,
      }));
      latestBlockNum = ringTip;
      latestBlockTs = ring[0]?.timestamp ?? 0;
      txInLatest = ring[0]?.txCount ?? null;
      ringSource = true;
    }

    // gasPrice is not in newHeads push; still needs eth_gasPrice. One method
    // per request, plus optional fallback for blocks.
    const tipPromise = ringSource ? Promise.resolve(latestBlockNum) : getTipNumber(network);
    const blocksPromise = ringSource
      ? Promise.resolve([] as unknown[])
      : getLatestBlocksBatched(network, 10, false);
    const [blockNumber, gasPrice, recentBlocks, epochResult] = await Promise.allSettled([
      tipPromise,
      getGasPrice(network),
      blocksPromise,
      getEpochState(network),
    ]);

    if (!ringSource) {
      const blocks = (recentBlocks.status === 'fulfilled' ? recentBlocks.value : []) as Array<{
        number: string; timestamp: string; transactions?: unknown[]; gasUsed: string; gasLimit: string;
      }>;
      const latestBlock = blocks[0] ?? null;
      recent = blocks.map(b => ({
        number: parseInt(b.number, 16),
        ts: parseInt(b.timestamp, 16),
        txCount: Array.isArray(b.transactions) ? b.transactions.length : null,
        gasUsed: parseInt(b.gasUsed, 16),
        gasLimit: parseInt(b.gasLimit, 16),
      }));
      latestBlockNum = blockNumber.status === 'fulfilled' ? Number(blockNumber.value) : 0;
      latestBlockTs = latestBlock ? parseInt(latestBlock.timestamp, 16) : 0;
      txInLatest = latestBlock
        ? (Array.isArray(latestBlock.transactions) ? latestBlock.transactions.length : null)
        : null;
    }

    const measured = computeChainStats(recent);
    const tps = measured.tps;
    const avgBlockTime = measured.avgBlockTime;
    const avgGasUtilization = measured.avgGasUtilization;

    // null, not 0. A failed eth_gasPrice used to become a literal 0.0000 that was written to
    // InfluxDB (the write below is guarded only on latestBlockNum), so /api/history's
    // mean(gas_gwei) carried that zero forever. Absence of a reading is not a reading of zero.
    const gasPriceGwei = gasPrice.status === 'fulfilled' ? Number(gasPrice.value) / 1e9 : null;
    const nowSec = Math.floor(Date.now() / 1000);
    const secondsSinceLastBlock = latestBlockTs ? nowSec - latestBlockTs : 999;

    const epochState = epochResult.status === 'fulfilled' ? epochResult.value : {
      current: null, inEpochDelayPeriod: null, fetchedAt: null, source: 'unavailable',
    };
    // Block position only estimates the next boundary block, NOT the delayed
    // epoch transition. Current epoch and delay status come from getEpoch().
    const blocksPerEpoch = NETWORKS[network].blocksPerEpoch;
    const blockInEpoch = latestBlockNum % blocksPerEpoch;
    const blocksUntilNextEpoch = blocksPerEpoch - blockInEpoch;
    const epochProgressPct = Math.round((blockInEpoch / blocksPerEpoch) * 1000) / 10;
    const secondsUntilNextEpoch = avgBlockTime != null
      ? Math.round(blocksUntilNextEpoch * avgBlockTime) : null;

    // Health analysis
    // Monad has no public mempool (local mempool per validator, not queryable).
    // Congestion signals: block utilization, block time drift, gas price spike.
    let health: 'normal' | 'congested' | 'offline' = 'normal';
    let healthReason = 'Network is running smoothly';

    if (!latestBlockNum || secondsSinceLastBlock > 30) {
      health = 'offline';
      healthReason = latestBlockNum
        ? `No new blocks for ${secondsSinceLastBlock}s`
        : 'RPC did not return a block';
    } else {
      const signals: string[] = [];
      if (avgGasUtilization != null && avgGasUtilization > 85) signals.push(`block utilization ${avgGasUtilization.toFixed(0)}%`);
      if (avgBlockTime != null && avgBlockTime > 3) signals.push(`block time ${avgBlockTime.toFixed(1)}s`);
      if (gasPriceGwei !== null && gasPriceGwei > 200) signals.push(`gas ${gasPriceGwei.toFixed(0)} Gwei`);

      if (signals.length >= 1) {
        health = 'congested';
        healthReason = `Congestion: ${signals.join(', ')}`;
      }
    }

    // Never persist missing or stale measurements as real zero readings.
    const fresh = latestBlockNum > 0 && secondsSinceLastBlock <= 30;
    if (network === 'testnet' && fresh) {
      const fields = [`block=${latestBlockNum}i`];
      if (txInLatest != null) fields.push(`txs_in_block=${txInLatest}i`);
      if (tps != null) fields.push(`tps=${tps.toFixed(3)}`);
      if (gasPriceGwei != null) fields.push(`gas_gwei=${gasPriceGwei.toFixed(4)}`);
      if (avgGasUtilization != null) fields.push(`block_util_pct=${avgGasUtilization.toFixed(2)}`);
      if (avgBlockTime != null) fields.push(`block_time=${avgBlockTime.toFixed(3)}`);
      void influxWrite(`monad_chain,network=${network} ${fields.join(',')} ${Date.now()}`);
    }

    return NextResponse.json({
      blockNumber: latestBlockNum,
      gasPrice: gasPriceGwei,
      tps: fresh && tps != null ? Math.round(tps * 100) / 100 : null,
      avgBlockTime: fresh && avgBlockTime != null ? Math.round(avgBlockTime * 1000) / 1000 : null,
      avgGasUtilization: fresh && avgGasUtilization != null ? Math.round(avgGasUtilization * 10) / 10 : null,
      txInLatestBlock: txInLatest,
      latestBlockTimestamp: latestBlockTs,
      secondsSinceLastBlock,
      epoch: {
        ...epochState,
        blockInEpoch,
        blocksPerEpoch,
        blocksUntilNext: blocksUntilNextEpoch,
        secondsUntilNext: secondsUntilNextEpoch,
        progressPct: epochProgressPct,
        estimateOnly: true,
      },
      sampleSize: measured.sampleSize,
      tpsWindowSeconds: measured.tpsWindowSeconds,
      tpsMethod: measured.tpsMethod,
      dataAsOf: latestBlockTs * 1000,
      stale: !fresh,
      health: {
        state: health,
        reason: healthReason,
      },
      source: ringSource ? 'ws-ring' : 'rpc-fallback',
    });
  } catch (err) {
    return apiError(err, 500, 'stats');
  }
}
