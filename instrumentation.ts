// Runs on Next.js server startup (Next 13.4+). Used here to keep InfluxDB
// populated even when no browser is on /node — /api/node only writes metrics
// when invoked, so without a background poll the history chart has gaps.

export async function register() {
  // Guard: only run in Node runtime (not edge), and only in production-style
  // server (`next start` / PM2) — dev mode `next dev` reloads frequently and
  // would spawn multiple overlapping pollers.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Re-entrancy guard across hot reloads / multiple register() calls.
  const g = globalThis as { __monadPollerStarted__?: boolean };
  if (g.__monadPollerStarted__) return;
  g.__monadPollerStarted__ = true;

  const port = Number(process.env.PORT ?? 3001);
  const user = process.env.NODE_AUTH_USER ?? '';
  const pass = process.env.NODE_AUTH_PASSWORD ?? '';
  const authHeader = user && pass
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : undefined;

  const poll = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/node`, {
        headers: authHeader ? { authorization: authHeader } : {},
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      });
      if (!res.ok && res.status !== 401) {
        // 401 means middleware rejected — log once at startup so the operator notices.
        // Other errors (5xx, network) we just swallow — next tick retries.
      }
    } catch {
      // Swallow network/timeout errors so the interval stays alive.
    }
  };

  // First poll after a short delay to let the server fully warm up.
  setTimeout(poll, 3000);
  setInterval(poll, 10_000);

  // ── Network health: reorg detector, validator set, peer geo ─────
  const {
    tickReorgDetector, tickValidatorSetTracker, refreshGeoDistribution,
  } = await import('./lib/networkHealth');

  // Reorg detector: 4s tick + depth-15 backfill. At 0.4s block time we see ~10
  // new blocks per tick — depth-15 covers all of them plus a 5-block safety
  // margin. Reduced from 2s/depth-30 (= 35 methods/2s = ~1050 methods/min) to
  // 4s/depth-15 (= 25 methods/4s = ~375 methods/min, -64%) after tcpdump
  // attribution showed steady eth_getBlockByNumber load was dominant cause of
  // monad-rpc triedb_env channel overflow. Reorgs at depth >15 don't happen
  // on Monad testnet historically (always depth 1-3).
  setTimeout(() => { tickReorgDetector(); setInterval(tickReorgDetector, 4_000); }, 5_000);

  // Validator set changes: check every 60s (stake doesn't churn fast)
  setTimeout(() => { tickValidatorSetTracker(); setInterval(tickValidatorSetTracker, 60_000); }, 15_000);

  // Peer geo: refresh every 30min (ip-api.com has rate limits; mesh is stable)
  setTimeout(() => { refreshGeoDistribution(); setInterval(refreshGeoDistribution, 30 * 60_000); }, 20_000);

  // (tickTpsCollector removed 2026-04-28: TPS chart reads from /api/history
  // (InfluxDB monad_chain) for all ranges. Removed 1Hz RPC polling — eliminates
  // ~150 methods/min of background load on monad-rpc.)

  // Exec stats persistence: parses monad-execution __exec_block logs from Loki
  // every 30s and writes new blocks to InfluxDB `monad_exec`. Enables
  // /api/exec-stats to serve ranges wider than Loki's practical 15-min window.
  const { tickExecWriter } = await import('./lib/execStats');
  setTimeout(() => { tickExecWriter(); setInterval(tickExecWriter, 30_000); }, 25_000);

  // Anomaly detectors: scrape Prometheus every 30s and emit incidents for
  // state-root mismatches, state-sync transitions, consensus stress (TC
  // ratio over 5min), sustained vote-delay p99, and local-vs-reference RPC
  // tip lag. Persists to InfluxDB `monad_anomalies` so events survive PM2
  // restarts. Surfaced in the public /incidents timeline.
  const { tickAnomalyDetectors } = await import('./lib/anomalyDetectors');
  setTimeout(() => { tickAnomalyDetectors(); setInterval(tickAnomalyDetectors, 30_000); }, 35_000);

  // WebSocket block stream: open one persistent ws:// connection to monad-rpc,
  // subscribe to newHeads, fill an in-RAM ring buffer (last 1000 blocks).
  // Replaces polling-based block fetches that overflowed the triedb_env
  // channel (see [[rpc-warn-storm-2026-04-26]] and [[websocket-migration-2026-04-27]]).
  // Each push triggers ONE eth_getBlockByNumber(num, false) for txCount
  // enrichment — single method per block, naturally smooth-paced (~150/min).
  const { startWsBlockStream } = await import('./lib/wsBlockStream');
  setTimeout(() => { startWsBlockStream(); }, 8_000);

  // Staking ops scanner — DISABLED 2026-04-24.
  // With MAX_PER_TICK=100 and full=true block fetches every 15s, each tick
  // fired one JSON-RPC batch with 30-100 methods, which the triedb_env
  // channel can't drain — caused scraper rate to jump from ~4 req/sec to
  // ~78 req/sec with WARN ×5.3. Re-enable only after redesign: either use
  // eth_getLogs as a pre-filter (so we fetch only blocks with staking
  // activity), or scan much slower (1-2 blocks/sec max, no batch catch-up).
  // const { tickStakingScanner } = await import('./lib/stakingOps');
  // setTimeout(() => { tickStakingScanner(); setInterval(tickStakingScanner, 15_000); }, 18_000);

  // Chain-stats poller: hits /api/stats every 15s so InfluxDB `monad_chain`
  // (tps, gas_gwei, block_util_pct) stays continuously populated regardless
  // of live viewer activity. Without this, /api/history has null gaps for
  // gas/util on longer ranges (6h+) whenever nobody was viewing the page.
  const statsPoll = async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/api/stats?network=testnet`, {
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      });
    } catch { /* swallow */ }
  };
  setTimeout(() => { statsPoll(); setInterval(statsPoll, 15_000); }, 12_000);

  // Top-contracts cache warmup. /api/top-contracts has 60s in-memory cache.
  // Cold cache for 15m window can take 25-30s on first hit (RPC fallback for
  // blocks beyond the WS ring). Background warmup keeps the user-facing
  // request always hitting warm cache. Runs slightly under TTL (50s) so a
  // user request always finds fresh data.
  const topContractsPoll = async () => {
    for (const window of ['5m', '15m', '1h']) {
      try {
        await fetch(
          `http://127.0.0.1:${port}/api/top-contracts?network=testnet&window=${window}&min=5&limit=20`,
          { signal: AbortSignal.timeout(60_000), cache: 'no-store' },
        );
      } catch { /* swallow — next tick retries */ }
    }
  };
  // First warmup after WS ring has ~30s of data. Keeps running every 50s.
  setTimeout(() => { void topContractsPoll(); setInterval(() => void topContractsPoll(), 50_000); }, 40_000);

  // eslint-disable-next-line no-console
  console.log(`[instrumentation] background pollers started: /api/node (10s), reorg (4s, depth=15), set-tracker (60s), geo (30m), exec-writer (30s), stats (15s), anomaly-detectors (30s), ws-block-stream (push), top-contracts-warmup (50s)`);
}
