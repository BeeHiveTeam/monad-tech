import { NextResponse } from 'next/server';
import { parsePrometheus, findOne } from '@/lib/prom-parser';

export const dynamic = 'force-dynamic';

const PROM_URL = process.env.PROM_URL || 'http://15.235.117.52:8889/metrics';
const LOCAL_RPC_URL = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';

// Returns live infra stats for our own BeeHive validator node: client version,
// block height, peer count, uptime, node identity. This is the data source for
// the public-facing /beehive page.
export async function GET() {
  try {
    const [promRes, rpcRes] = await Promise.allSettled([
      fetch(PROM_URL, { signal: AbortSignal.timeout(5_000), cache: 'no-store' }),
      // Our own RPC's tip is the truthful "current height" — the Prometheus
      // metric `monad_execution_ledger_block_num` lags by 5-8 blocks due to
      // otelcol scrape + journal propagation. Using RPC avoids showing a
      // misleading "Δ -6 vs network" on a node that's actually in sync.
      fetch(LOCAL_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      }),
    ]);

    if (promRes.status !== 'fulfilled' || !promRes.value.ok) {
      return NextResponse.json({ error: `Prometheus unreachable` }, { status: 502 });
    }
    const text = await promRes.value.text();
    const samples = parsePrometheus(text);

    // Node identity lives in labels on monad_node_info
    const nodeInfo = findOne(samples, 'monad_node_info');
    const clientVersion = nodeInfo?.labels?.service_version ?? null;
    const serviceName = nodeInfo?.labels?.service_name ?? null;
    const network = nodeInfo?.labels?.network ?? 'testnet';

    // Prometheus tells us committed-to-ledger height (slightly lagged by
    // export pipeline). The RPC call above gives us the real-time tip.
    const execLedgerHeight = findOne(samples, 'monad_execution_ledger_block_num')?.value ?? 0;

    let rpcHeight = 0;
    if (rpcRes.status === 'fulfilled' && rpcRes.value.ok) {
      try {
        const j = await rpcRes.value.json() as { result?: string };
        if (j.result) rpcHeight = parseInt(j.result, 16);
      } catch { /* fall through with 0 */ }
    }
    // Prefer the RPC height when available; fall back to Prometheus if RPC
    // didn't respond (e.g. during a brief network blip).
    const blockNum = rpcHeight > 0 ? rpcHeight : execLedgerHeight;

    const numCommits = findOne(samples, 'monad_execution_ledger_num_commits')?.value ?? 0;
    const numTxCommits = findOne(samples, 'monad_execution_ledger_num_tx_commits')?.value ?? 0;
    const peers = findOne(samples, 'monad_peer_disc_num_peers')?.value ?? 0;
    const pendingPeers = findOne(samples, 'monad_peer_disc_num_pending_peers')?.value ?? 0;
    const upstreamValidators = findOne(samples, 'monad_peer_disc_num_upstream_validators')?.value ?? 0;

    // Sample timestamp — used as "last heartbeat from our node"
    const lastSeenMs = nodeInfo?.timestampMs ?? Date.now();

    const configured = {
      validatorAddress: process.env.BEEHIVE_VALIDATOR_ADDRESS ?? null,
      commissionPct: Number(process.env.BEEHIVE_COMMISSION_PCT ?? '5'),
      minDelegation: Number(process.env.BEEHIVE_MIN_DELEGATION ?? '100'),
      twitter: process.env.BEEHIVE_TWITTER ?? 'BeeHive_NT',
      discord: process.env.BEEHIVE_DISCORD ?? 'mav3rick_iphone',
      // Direct-link target for Discord. Priority order:
      //   1. BEEHIVE_DISCORD_URL — explicit URL (e.g. server invite like
      //      https://discord.gg/XXXXX or profile https://discord.com/users/<user_id>)
      //   2. BEEHIVE_DISCORD_USER_ID — numeric ID → builds profile URL
      //   3. null — client falls back to copy-username-to-clipboard
      discordUrl: process.env.BEEHIVE_DISCORD_URL
        ?? (process.env.BEEHIVE_DISCORD_USER_ID
            ? `https://discord.com/users/${process.env.BEEHIVE_DISCORD_USER_ID}`
            : null),
      website: process.env.BEEHIVE_WEBSITE ?? 'https://bee-hive.work',
    };

    return NextResponse.json({
      operator: 'BeeHive',
      network,
      serviceName,
      clientVersion,
      ourBlockHeight: Math.round(blockNum),
      commits: {
        totalBlocks: Math.round(numCommits),
        totalTxs: Math.round(numTxCommits),
      },
      peers: {
        active: Math.round(peers),
        pending: Math.round(pendingPeers),
        upstreamValidators: Math.round(upstreamValidators),
      },
      lastSeenMs,
      configured,
      fetchedAt: Date.now(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
