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
  const { tickTpsCollector } = await import('./lib/tpsTimeline');

  // Reorg detector: poll tip every 10s. Reorgs are rare and depth 1-3 at ~0.4s
  // blocks = <1.2s window, which we catch on the next tick even at 10s cadence
  // (the old hash stays in memory until overwritten, so we still notice).
  // 2s was 5× what we need and contributed heavily to RPC amplification.
  setTimeout(() => { tickReorgDetector(); setInterval(tickReorgDetector, 10_000); }, 5_000);

  // Validator set changes: check every 60s (stake doesn't churn fast)
  setTimeout(() => { tickValidatorSetTracker(); setInterval(tickValidatorSetTracker, 60_000); }, 15_000);

  // Peer geo: refresh every 30min (ip-api.com has rate limits; mesh is stable)
  setTimeout(() => { refreshGeoDistribution(); setInterval(refreshGeoDistribution, 30 * 60_000); }, 20_000);

  // TPS per-second collector: polls new blocks every 1s, aggregates tx counts
  // into per-second buckets for the 5m/15m/1h TPS chart. Monad block time
  // is ~0.4s so each tick fetches 2-3 new blocks via RPC batch.
  setTimeout(() => { tickTpsCollector(); setInterval(tickTpsCollector, 1_000); }, 8_000);

  // Exec stats persistence: parses monad-execution __exec_block logs from Loki
  // every 30s and writes new blocks to InfluxDB `monad_exec`. Enables
  // /api/exec-stats to serve ranges wider than Loki's practical 15-min window.
  const { tickExecWriter } = await import('./lib/execStats');
  setTimeout(() => { tickExecWriter(); setInterval(tickExecWriter, 30_000); }, 25_000);

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

  // eslint-disable-next-line no-console
  console.log(`[instrumentation] background pollers started: /api/node (10s), reorg (10s), tps-collector (1s), set-tracker (60s), geo (30m), exec-writer (30s), stats (15s)`);
}
