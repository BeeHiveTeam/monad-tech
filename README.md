# monad-tech

Real-time **Monad testnet observability dashboard** — with focus on the things other explorers don't show: parallel-execution metrics, a unified incident timeline, validator health scoring, and network-wide decentralization insights.

🌐 Live: <https://monad-tech.com> · (legacy alias <https://monad-tech.bee-hive.work>)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)

---

## Why this exists

Block explorers like MonadScan cover the basics (blocks, txs, gas). This dashboard adds the things operators and delegators actually need to see:

- **`retry_pct`** — share of transactions re-executed per block due to parallel-execution conflicts. Unique to Monad's OCC engine. Surfaces which contracts break parallelism.
- **Block execution time breakdown** — `state_reset` / `tx_exec` / `commit` phases in microseconds.
- **Top contracts by retry rate** — parallelism hotspots ranked.
- **Unified incident timeline** — reorgs · validator churn · retry spikes · block stalls · critical logs, all in one chronological feed with persistence across restarts.
- **Validator health score** — composite of block-production, uptime, recency, with penalty for unregistered signers.
- **Network decentralization** — Nakamoto 33/50/66 coefficients, peer geo distribution, client version tracking.

The goal: be the single dashboard where an operator can diagnose "is my node lagging, or is the whole network halted?" and where a delegator can compare validators on dimensions that matter.

---

## Features (quick tour)

### Network Status — the home page
- Live KPIs: latest block, TPS, gas, block time, utilization
- Epoch progress
- **Parallel execution panel**: retry_pct avg/peak, effective TPS peak, stacked execution-time breakdown
- **Top contracts by retry rate** table
- TPS / Gas / Util chart with "pixelated" squared bars
- Latest blocks + transactions with pagination + search

### Validators
- 316-row sortable table
- Filter: `REGISTERED ONLY` toggle (hides block producers without a matched on-chain authAddress)
- Score = 40% health + 40% uptime + 20% recency, with 0.7× penalty for unregistered
- Columns: moniker · address · stake · commission · score · health · uptime · blocks · share · txs · last-block

### Network Health
- Nakamoto coefficient breakdown
- Recent reorgs (usually zero — MonadBFT gives deterministic finality)
- Peer geo distribution (by country + ASN)
- Validator set changes log

### Incidents
- Unified feed: **reorg** · **validator_added/removed/stake_decrease** · **retry_spike** · **block_stall** · **critical_log**
- Filter by severity (all / critical / warn / info)
- Filter by range (1h / 6h / 12h / 24h / 7d)
- Persistent: survives PM2 restarts (InfluxDB-backed)

### BeeHive
- Operator landing page with live infra telemetry
- Client version + sync status + peer count
- Commission / minimum-delegation details
- Delegate CTA (Twitter · Discord · website)

---

## Architecture

```
                  ┌─── /api/stats, /api/blocks, /api/transactions
                  │    (JSON-RPC batched, tip-cached 500ms)
                  │
  Monad testnet   ├─── /api/tps-timeline (per-second collector, 1-Hz poll)
  RPC node        │
                  ├─── /api/validators (5000-block sample + staking-precompile
                  │    enumeration via eth_call batch)
                  │
                  └─── /api/network-health (tip-hash sweep for reorgs)

                       ┌─── /api/exec-stats       (retry_pct, exec breakdown)
  Loki (logs)    ──────┼─── /api/top-contracts    (hot contracts by retry)
                       └─── /api/incidents        (critical logs)

  Prometheus     ──────┼─── /api/node  (host probes, services, event counters)
  (otelcol)            └─── /api/beehive  (client version, height, peers)

  InfluxDB       ──────┬─── /api/history            (chain-metric aggregates)
  (persistence)        ├─── /api/exec-stats >15m    (retry_pct long-range)
                       ├─── /api/incidents >15m     (persisted reorgs + valset)
                       └─── /api/analytics/summary  (site analytics)
```

Background pollers in `instrumentation.ts`:
- reorg detector (10 s)
- per-second TPS collector (1 s)
- validator set tracker (60 s)
- peer-geo refresh (30 min)
- exec-stats writer to InfluxDB (30 s)
- chain-stats poller (15 s)

### Stack

- **Next.js 16** (App Router, Turbopack, client + server components)
- **TypeScript** strict
- **Tailwind v4** for base + inline styles for dark gold theme
- **Recharts** for charts
- **Nginx** reverse proxy + **Cloudflare** CDN
- **PM2** process manager, fork mode

---

## Running locally

```bash
# 1. Install
npm ci

# 2. Environment — copy template and edit
cp .env.example .env.local
$EDITOR .env.local     # at minimum set MONAD_RPC_URL

# 3. Dev mode (hot reload)
npm run dev
# → http://localhost:3000

# 4. Production
npm run build
npm run start -- -p 3001
```

### What you need for full functionality

| Feature | Requires |
|---------|----------|
| Blocks / txs / TPS chart | `MONAD_RPC_URL` only |
| `retry_pct` + top-contracts | Loki with `monad-execution` journald logs |
| Persistent historical charts | InfluxDB 1.x reachable |
| `/node` (internal dashboard) | `PROM_URL` pointing at an otelcol-exposed endpoint + `NODE_AUTH_*` |
| `/beehive` landing | `PROM_URL` + optional `BEEHIVE_*` env |

Without Loki / InfluxDB the dashboard still works, just with reduced historical depth.

---

## Deployment

This repo runs in production behind Nginx + Cloudflare at <https://monad-tech.com>. The deploy pattern:

```bash
# On the server
cd /path/to/monad-tech
git pull
npm ci --omit=dev
npm run build
pm2 restart monad-stats
```

Nginx vhost example (with Cloudflare Origin Cert):

```nginx
server {
    listen 443 ssl http2;
    server_name monad-tech.com www.monad-tech.com;

    ssl_certificate     /etc/nginx/ssl/monad-tech.com/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/monad-tech.com/key.pem;

    # HSTS, CSP, rate-limit zones — see docs
    location /api/ { proxy_pass http://127.0.0.1:3001; }
    location /    { proxy_pass http://127.0.0.1:3001; }
}
```

Middleware in `middleware.ts` adds in-app rate limiting (300 req / min / IP). Cloudflare handles the outer layer.

---

## Design choices that matter

- **Shared tip cache** (`lib/tipCache.ts`) — 500 ms TTL, deduplicates `eth_blockNumber` requests across all pollers. Critical for avoiding Monad RPC burst amplification in `triedb_env` channel.
- **JSON-RPC batching** — `/api/blocks`, `/api/transactions`, `/api/stats` all batch instead of `Promise.all` of N individual calls. ~6× fewer TCP connections.
- **Staking-precompile slot 8** — `totalStake`, NOT slot 2 (self-stake). Getting this wrong shows validators below the active-set floor.
- **Unregistered signer handling** — ~15 % of block producers use a separate signing key, not their authAddress. We label them, don't hide them, and apply a 0.7× score penalty.
- **InfluxDB dual-source** — `/api/exec-stats` ≤ 15 min → Loki (freshest), > 15 min → InfluxDB (persisted). Writer polls every 30 s.

---

## Roadmap (short list)

- [ ] Tip-lag vs reference RPC — "is my node lagging vs the network?"
- [ ] Telegram / Discord bot for critical incidents
- [ ] AS / ISP concentration detector → new incident type
- [ ] Light-theme toggle
- [ ] Public API docs (OpenAPI)
- [ ] Validator comparison tool (pick 2-3, side-by-side)

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## Author / operator

Built and operated by [BeeHive](https://bee-hive.work) — a node-infrastructure team running validators across Lido, Obol, SSV, Mina, Provenance, Stellar, and Monad.

- Twitter / X — [@BeeHive_NT](https://x.com/BeeHive_NT)
- Discord — `mav3rick_iphone`
