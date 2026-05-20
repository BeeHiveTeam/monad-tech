import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/apiError';
import { getValidatorInfo } from '@/lib/validator-monikers';
import { ensureRegistryLoaded, getConsensusIds, getChainDataById } from '@/lib/validator-registry';
import { NETWORKS, NetworkId } from '@/lib/networks';

export const dynamic = 'force-dynamic';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const TOPIC0_VALIDATOR_REWARDED =
  '0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754';

const SCAN_RANGE_BLOCKS = 100_000; // ~11 hours at 0.4s blocks — adjust if RPC limits hit
const MAX_WINDOW_BLOCKS = 100_000; // hard cap — previously 500K, dropped to respect [[monad-rpc-pacing]]
const CHUNK_SIZE = 1000;
const CHUNK_PAUSE_MS = 200; // [[monad-rpc-pacing]] rule — minimum gap between eth_getLogs chunks
const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

// In-memory cache keyed by (network, address, windowBlocks, limit, format).
// 60s TTL — slow-moving on-chain data, no benefit from shorter. Per-key isolation
// avoids the trap of caching `?format=csv` with `?format=json`'s entry.
const _auditCache = new Map<string, { ts: number; data: unknown; csvBody?: string }>();
const AUDIT_CACHE_TTL_MS = 60_000;

interface RewardLog {
  blockNumber: number;
  validatorId: number;
  fromAddress: string;
  amount: bigint;
  epoch: number;
  txHash: string;
  logIndex: number;
}

interface AuditRecord {
  type: 'reward' | 'commission_change' | 'stake_change';
  blockNumber: number;
  timestamp: number | null;
  amount: string | null; // MON amount as decimal string
  validatorId: number;
  txHash: string | null;
  reason: string;
}

async function fetchLogChunk(
  rpcUrl: string,
  validatorIds: number[],
  fromBlock: number,
  toBlock: number,
): Promise<RewardLog[]> {
  if (validatorIds.length === 0) return [];

  // Topic1 filter = validatorId zero-padded to 32 bytes
  const topic1s = validatorIds.map(id =>
    '0x' + id.toString(16).padStart(64, '0')
  );

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
    params: [{
      address: STAKING_PRECOMPILE,
      topics: [TOPIC0_VALIDATOR_REWARDED, topic1s],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
    }],
  });

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const j = await res.json() as {
      result?: Array<{
        blockNumber: string;
        topics: string[];
        data: string;
        transactionHash: string;
        logIndex: string;
      }>;
      error?: { message: string };
    };
    if (j.error || !j.result) return [];

    return j.result.map(log => {
      const dataNoPrefix = log.data.slice(2);
      const amount = BigInt('0x' + dataNoPrefix.slice(0, 64));
      const epoch = parseInt(dataNoPrefix.slice(64, 128), 16);
      return {
        blockNumber: parseInt(log.blockNumber, 16),
        validatorId: parseInt(log.topics[1], 16),
        fromAddress: '0x' + log.topics[2].slice(-40),
        amount,
        epoch,
        txHash: log.transactionHash,
        logIndex: parseInt(log.logIndex, 16),
      };
    });
  } catch {
    return [];
  }
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

async function getBlockTimestamp(rpcUrl: string, blockNumber: number): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber',
        params: ['0x' + blockNumber.toString(16), false],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { result?: { timestamp?: string } };
    if (j.result?.timestamp) return parseInt(j.result.timestamp, 16);
    return null;
  } catch { return null; }
}

// CSV-cell quoter: wraps every value in "…", escapes embedded quotes by doubling,
// and prefixes a leading formula-trigger char (= + - @ TAB CR) with a single
// quote so Excel/Sheets won't auto-evaluate. Numbers/booleans coerced to string.
function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

const ONE_MON = BigInt('1000000000000000000'); // 1e18
const TEN_K = BigInt(10000);

function formatMon(amountWei: bigint): string {
  const whole = amountWei / ONE_MON;
  const frac = amountWei % ONE_MON;
  // 4 decimal places
  const fracStr = (frac * TEN_K / ONE_MON).toString().padStart(4, '0');
  return `${whole}.${fracStr}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const addr = address.toLowerCase();

  // Reject malformed addresses before they hit ensureRegistryLoaded (which fans
  // out 200+ RPC calls on cold start) and before they're interpolated into
  // Content-Disposition. Audit-pass [[post-deploy-audit-findings-2026-05-20]]
  // flagged this as a CRLF-injection / path-traversal vector even though
  // Next.js normalises response headers today.
  if (!ADDRESS_RE.test(addr)) {
    return apiError(new Error('invalid address format'), 400, 'audit/invalid-address');
  }

  const sp = req.nextUrl.searchParams;
  const rawNet = sp.get('network') ?? 'testnet';
  const network: NetworkId = (rawNet === 'mainnet' ? 'mainnet' : 'testnet');

  // Number.isFinite guard — `parseInt('') || default` doesn't catch `0` (falsy),
  // which previously triggered a full-history scan. NaN guard same fix.
  const wbRaw = parseInt(sp.get('windowBlocks') ?? '', 10);
  const windowBlocks = Number.isFinite(wbRaw) && wbRaw > 0
    ? Math.min(wbRaw, MAX_WINDOW_BLOCKS)
    : SCAN_RANGE_BLOCKS;

  const lmRaw = parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(lmRaw) && lmRaw > 0 ? Math.min(lmRaw, 5000) : 500;

  const format = sp.get('format') === 'csv' ? 'csv' : 'json';

  const cacheKey = `${network}:${addr}:${windowBlocks}:${limit}:${format}`;
  const cached = _auditCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AUDIT_CACHE_TTL_MS) {
    if (format === 'csv' && cached.csvBody) {
      return new NextResponse(cached.csvBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="audit-${addr}-${network}.csv"`,
        },
      });
    }
    return NextResponse.json(cached.data);
  }

  try {
    const rpcUrl = (network === 'testnet' && process.env.MONAD_RPC_URL)
      ? process.env.MONAD_RPC_URL
      : NETWORKS[network].rpc;

    await ensureRegistryLoaded(rpcUrl, network);

    const info = getValidatorInfo(addr, network);

    // Resolve all validatorIds owned by this auth address — supports multi-ID operators
    const chainData = getChainDataById(network);
    const ownedValidatorIds: number[] = [];
    for (const [id, data] of chainData) {
      if (data.authAddress.toLowerCase() === addr) ownedValidatorIds.push(id);
    }
    if (ownedValidatorIds.length === 0 && info?.validatorId) {
      ownedValidatorIds.push(info.validatorId);
    }

    if (ownedValidatorIds.length === 0) {
      return NextResponse.json({
        address: addr,
        network,
        moniker: info?.moniker ?? null,
        validatorIds: [],
        rewards: [],
        summary: {
          totalRewardsMon: '0.0000',
          rewardCount: 0,
          blocksProduced: 0,
          windowBlocks: 0,
          firstRewardBlock: null,
          lastRewardBlock: null,
        },
        error: 'No validator IDs associated with this address',
        fetchedAt: Date.now(),
      });
    }

    const tip = await getLatestBlock(rpcUrl);
    if (tip === null) {
      return apiError(new Error('RPC unavailable'), 503, `audit/${addr}`);
    }

    const fromBlock = Math.max(0, tip - windowBlocks);

    // Fetch logs in chunks to respect RPC log-range limits. Insert CHUNK_PAUSE_MS
    // between chunks per [[monad-rpc-pacing]] — burst patterns overflow the
    // monad-rpc triedb_env channel and cause WARN-storm. First chunk has no
    // pause (single curl shouldn't pay a 200ms latency floor for nothing).
    const allLogs: RewardLog[] = [];
    let firstChunk = true;
    for (let from = fromBlock; from <= tip; from += CHUNK_SIZE) {
      if (!firstChunk) await new Promise(r => setTimeout(r, CHUNK_PAUSE_MS));
      firstChunk = false;
      const to = Math.min(from + CHUNK_SIZE - 1, tip);
      const logs = await fetchLogChunk(rpcUrl, ownedValidatorIds, from, to);
      allLogs.push(...logs);
      if (allLogs.length >= limit * 2) break; // safety
    }

    // Sort by block descending
    allLogs.sort((a, b) => b.blockNumber - a.blockNumber);
    const recent = allLogs.slice(0, limit);

    // Fetch timestamps for first N records (parallel, bounded). UI renders top
    // 100 rows; align fetch limit so rows 51-100 don't show "—" for timestamp.
    const TIMESTAMP_FETCH_LIMIT = Math.min(100, recent.length);
    const tsPromises = recent.slice(0, TIMESTAMP_FETCH_LIMIT).map(r =>
      getBlockTimestamp(rpcUrl, r.blockNumber).then(ts => [r.blockNumber, ts] as const)
    );
    const tsResults = await Promise.all(tsPromises);
    const tsMap = new Map(tsResults);

    // Build audit records
    const records: AuditRecord[] = recent.map(log => ({
      type: 'reward',
      blockNumber: log.blockNumber,
      timestamp: tsMap.get(log.blockNumber) ?? null,
      amount: formatMon(log.amount),
      validatorId: log.validatorId,
      txHash: log.txHash,
      reason: `Block reward for producing block ${log.blockNumber} (epoch ${log.epoch})`,
    }));

    // Summary
    const totalWei = allLogs.reduce((s, l) => s + l.amount, BigInt(0));
    const summary = {
      totalRewardsMon: formatMon(totalWei),
      rewardCount: allLogs.length,
      blocksProduced: allLogs.length, // 1 reward per block produced
      windowBlocks: tip - fromBlock,
      firstRewardBlock: allLogs.length ? allLogs[allLogs.length - 1].blockNumber : null,
      lastRewardBlock: allLogs.length ? allLogs[0].blockNumber : null,
    };

    const data = {
      address: addr,
      network,
      moniker: info?.moniker ?? null,
      commissionPct: info?.commissionPct ?? null,
      validatorIds: ownedValidatorIds,
      summary,
      rewards: records,
      fetchedAt: Date.now(),
    };

    // CSV export — every cell is fully quoted and formula-injection-escaped.
    // Even though current fields are all server-generated (no user-controllable
    // strings), future additions like `moniker` would silently expose
    // formula injection in Excel/Sheets. Defence-in-depth, ~5 lines.
    if (format === 'csv') {
      const header = 'block_number,timestamp_iso,amount_mon,validator_id,tx_hash,type,reason';
      const rows = records.map(r => {
        const tsIso = r.timestamp ? new Date(r.timestamp * 1000).toISOString() : '';
        return [
          r.blockNumber,
          tsIso,
          r.amount,
          r.validatorId,
          r.txHash ?? '',
          r.type,
          r.reason ?? '',
        ].map(csvCell).join(',');
      });
      const csvBody = [header, ...rows].join('\n');
      _auditCache.set(cacheKey, { ts: Date.now(), data, csvBody });
      return new NextResponse(csvBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="audit-${addr}-${network}.csv"`,
        },
      });
    }

    _auditCache.set(cacheKey, { ts: Date.now(), data });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err, 500, `audit/${addr}`);
  }
}
