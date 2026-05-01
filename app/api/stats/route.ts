import { NextRequest, NextResponse } from 'next/server';
import { getGasPrice, getLatestBlocksBatched } from '@/lib/rpc';
import { getTipNumber } from '@/lib/tipCache';
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
    let recent: Array<{ ts: number; txCount: number; gasUsed: number; gasLimit: number }> = [];
    let latestBlockNum = 0;
    let latestBlockTs = 0;
    let txInLatest = 0;
    let ringSource = false;

    // The ring buffer is filled by our testnet WS subscription only —
    // bypass it for mainnet (we'd serve testnet data otherwise).
    const ring = network === 'testnet' ? getRingBlocks(10) : [];
    const ringTip = network === 'testnet' ? getRingTip() : null;
    if (ring.length >= 2 && ringTip) {
      recent = ring.map(b => ({
        ts: b.timestamp,
        txCount: b.txCount ?? 0,
        gasUsed: b.gasUsed,
        gasLimit: b.gasLimit,
      }));
      latestBlockNum = ringTip;
      latestBlockTs = ring[0]?.timestamp ?? 0;
      txInLatest = ring[0]?.txCount ?? 0;
      ringSource = true;
    }

    // gasPrice is not in newHeads push; still needs eth_gasPrice. One method
    // per request, plus optional fallback for blocks.
    const tipPromise = ringSource ? Promise.resolve(latestBlockNum) : getTipNumber(network);
    const blocksPromise = ringSource
      ? Promise.resolve([] as unknown[])
      : getLatestBlocksBatched(network, 10, false);
    const [blockNumber, gasPrice, recentBlocks] = await Promise.allSettled([
      tipPromise,
      getGasPrice(network),
      blocksPromise,
    ]);

    if (!ringSource) {
      const blocks = (recentBlocks.status === 'fulfilled' ? recentBlocks.value : []) as Array<{
        timestamp: string; transactions?: unknown[]; gasUsed: string; gasLimit: string;
      }>;
      const latestBlock = blocks[0] ?? null;
      recent = blocks.map(b => ({
        ts: parseInt(b.timestamp, 16),
        txCount: Array.isArray(b.transactions) ? b.transactions.length : 0,
        gasUsed: parseInt(b.gasUsed, 16),
        gasLimit: parseInt(b.gasLimit, 16),
      }));
      latestBlockNum = blockNumber.status === 'fulfilled' ? Number(blockNumber.value) : 0;
      latestBlockTs = latestBlock ? parseInt(latestBlock.timestamp, 16) : 0;
      txInLatest = latestBlock
        ? (Array.isArray(latestBlock.transactions) ? latestBlock.transactions.length : 0)
        : 0;
    }

    // Compute TPS, block time, avg gas utilization from recent blocks
    let tps = 0;
    let avgBlockTime = 0;
    let avgGasUtilization = 0;
    if (recent.length >= 2) {
      // Monad blocks ~0.5s but RPC timestamps are integer seconds — use total span / count
      const totalTx = recent.reduce((s, b) => s + b.txCount, 0);
      const totalTime = recent[0].ts - recent[recent.length - 1].ts;
      avgBlockTime = recent.length > 1 && totalTime > 0
        ? totalTime / (recent.length - 1)
        : 0;
      tps = totalTime > 0 ? totalTx / totalTime : 0;

      const utilizations = recent.filter(b => b.gasLimit > 0).map(b => b.gasUsed / b.gasLimit);
      avgGasUtilization = utilizations.length
        ? (utilizations.reduce((a, b) => a + b, 0) / utilizations.length) * 100
        : 0;
    }

    const gasPriceGwei = gasPrice.status === 'fulfilled' ? Number(gasPrice.value) / 1e9 : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const secondsSinceLastBlock = latestBlockTs ? nowSec - latestBlockTs : 999;

    // Epoch calculation (Monad testnet: 50k blocks/epoch, 1-based index).
    // Verified against explorer: block 26,918,644 → epoch 539.
    const blocksPerEpoch = NETWORKS[network].blocksPerEpoch;
    const currentEpoch = latestBlockNum > 0
      ? Math.floor(latestBlockNum / blocksPerEpoch) + 1
      : 0;
    const blockInEpoch = latestBlockNum % blocksPerEpoch;
    const blocksUntilNextEpoch = blocksPerEpoch - blockInEpoch;
    const epochProgressPct = Math.round((blockInEpoch / blocksPerEpoch) * 1000) / 10;
    const secondsUntilNextEpoch = avgBlockTime > 0
      ? Math.round(blocksUntilNextEpoch * avgBlockTime)
      : 0;

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
      if (avgGasUtilization > 85) signals.push(`block utilization ${avgGasUtilization.toFixed(0)}%`);
      if (avgBlockTime > 3) signals.push(`block time ${avgBlockTime.toFixed(1)}s`);
      if (gasPriceGwei > 200) signals.push(`gas ${gasPriceGwei.toFixed(0)} Gwei`);

      if (signals.length >= 1) {
        health = 'congested';
        healthReason = `Congestion: ${signals.join(', ')}`;
      }
    }

    // Write chain metrics to InfluxDB (fire-and-forget) — only for testnet,
    // which is the only active network and the one exposed on the dashboard.
    if (network === 'testnet' && latestBlockNum > 0) {
      const nowMs = Date.now();
      const chainLine =
        `monad_chain,network=${network} ` +
        `tps=${tps.toFixed(3)},gas_gwei=${gasPriceGwei.toFixed(4)},` +
        `block_util_pct=${avgGasUtilization.toFixed(2)},block_time=${avgBlockTime.toFixed(3)},` +
        `block=${latestBlockNum}i,txs_in_block=${txInLatest}i ${nowMs}`;
      influxWrite(chainLine);
    }

    return NextResponse.json({
      blockNumber: latestBlockNum,
      gasPrice: gasPriceGwei,
      tps: Math.round(tps * 100) / 100,
      avgBlockTime: Math.round(avgBlockTime * 10) / 10,
      avgGasUtilization: Math.round(avgGasUtilization * 10) / 10,
      txInLatestBlock: txInLatest,
      latestBlockTimestamp: latestBlockTs,
      secondsSinceLastBlock,
      epoch: {
        current: currentEpoch,
        blockInEpoch,
        blocksPerEpoch,
        blocksUntilNext: blocksUntilNextEpoch,
        secondsUntilNext: secondsUntilNextEpoch,
        progressPct: epochProgressPct,
      },
      health: {
        state: health,
        reason: healthReason,
      },
      source: ringSource ? 'ws-ring' : 'rpc-fallback',
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
