# Metrics & Parameters Reference

This document explains every metric, badge, chart, and number visible on [monad-tech.com](https://monad-tech.com). Written for two audiences:

- **Newcomers** to blockchain infrastructure — the *Glossary* and "What this means" sections assume zero prior knowledge.
- **Operators and delegators** evaluating the network — the *Interpretation* sections explain how to read each value to make decisions.

If something is missing or unclear, please open an issue.

---

## Table of contents

- [Glossary](#glossary)
- [Color and threshold conventions](#color-and-threshold-conventions)
- [Network Status (home page)](#network-status-home-page)
  - [Site header](#site-header)
  - [Network badge](#network-badge)
  - [Network Health card](#network-health-card)
  - [Health badge & Epoch card](#health-badge--epoch-card)
  - [Stat cards (×6)](#stat-cards-6)
  - [Parallel Execution panel](#parallel-execution-panel)
  - [Top Contracts by Retry Rate](#top-contracts-by-retry-rate)
  - [Transactions per Second / Gas Price / Block Utilization chart](#transactions-per-second--gas-price--block-utilization-chart)
  - [Latest Blocks](#latest-blocks)
  - [Latest Transactions](#latest-transactions)
- [Validators page](#validators-page)
- [Network Health page](#network-health-page)
- [Incidents page](#incidents-page)
- [BeeHive page](#beehive-page)
- [API endpoints](#api-endpoints)
- [Data sources](#data-sources)

---

## Glossary

**Blockchain** — a shared journal of transactions agreed upon by many independent computers. Once written, a record cannot be silently changed.

**Block** — one page of that journal. On Monad a new block is produced roughly every **0.4 seconds**, containing a batch of transactions.

**Transaction (tx)** — a single entry in a block: "address A sent 5 MON to address B", or "address C called function `swap()` on contract D".

**Validator (a.k.a. node)** — a computer running the Monad software that participates in writing and verifying blocks. Monad has ~314 registered validators, of which ~200 are in the active set (producing blocks).

**Stake** — MON tokens locked by a validator (or delegated to it) as a financial bond. A validator with more stake has more weight in consensus and gets paged for misbehaviour (`slashing`).

**Epoch** — a period of about 50,000 blocks (~5h 30m on testnet) during which the validator set and stakes are fixed. At epoch boundaries, stakes and rewards reconcile.

**Gas** — a unit measuring the computational cost of a transaction. Senders pay `gas_used × gas_price` as a fee. Heavier operations cost more gas.

**RPC (JSON-RPC)** — the API every validator exposes for querying blockchain state. This dashboard queries our local validator's RPC.

**OCC (Optimistic Concurrency Control)** — Monad's parallel-execution engine. Multiple transactions try to run in parallel; if two conflict (touch the same state), the engine retries the loser. The retry rate is a unique Monad metric.

**Reorg (chain reorganization)** — a rare event where the network agrees that the last N blocks should be replaced by a different chain of N blocks. Usually depth 1–3 and benign; deeper reorgs are concerning.

---

## Color and threshold conventions

Used consistently across the site:

| Color | Meaning |
|-------|---------|
| 🟢 Green | Healthy / good |
| 🟡 Gold | Normal operating range |
| 🟠 Amber | Watch — approaching trouble |
| 🔴 Red | Bad — investigate |

Specific thresholds appear in each section below.

---

## Network Status (home page)

URL: `/`

### Site header

Three elements (left to right):

| Element | What it means |
|---------|---------------|
| **MONAD TECH / NETWORK MONITOR** | Site title and subtitle. |
| **Monad Testnet / Monad Mainnet (soon)** | Network selector. Testnet is live — a sandbox for testing before mainnet. Mainnet placeholder will activate when the network launches. |
| **LIVE / time** indicator | Green `LIVE` = receiving fresh data. Gray `OFFLINE` = updates failed (3+ consecutive failures or last update >30s old). The time shown is the last successful poll. |

### Network badge

Plain label `Monad Testnet · Chain ID: 10143`. The chain ID is the unique numeric identifier of the network, needed when configuring wallets and contracts.

### Network Health card

A single horizontal strip giving an at-a-glance health summary. Includes:

| Field | What it means |
|-------|---------------|
| **Client version (RPC / installed)** | Version of the Monad node software on (a) the public RPC gateway, (b) our own validator. Compared against the latest GitHub release. If our version is behind, an update is recommended. |
| **Peer Geo Distribution** | Top countries and ASNs (hosting providers) hosting the network's validators. Healthy networks are geographically and infrastructurally diverse. |

The `DETAILS →` link opens the [Network Health page](#network-health-page) for the full breakdown.

### Health badge & Epoch card

Two cards side by side:

#### Health badge

| Value | Meaning |
|-------|---------|
| 🟢 `Normal` | Network operating smoothly (block production steady, no stalls). |
| 🟡 `Congested` | Blocks slower than normal or other temporary degradation. |
| 🔴 `Offline` | Critical — RPC unreachable or chain stalled. |

#### Epoch card

| Field | Meaning |
|-------|---------|
| `Current` | Current epoch number (e.g. 552). |
| `Block in epoch` | Blocks produced in this epoch so far. |
| `Blocks per epoch` | Total blocks per epoch on Monad (50,000). |
| `Blocks until next` | Remaining blocks until epoch boundary. |
| `Seconds until next` | Approximate wall-clock time to next epoch (`blocks_until_next × avg_block_time`). |
| `Progress` | Percentage through the current epoch. |

**Why epochs matter:** stake changes and reward distribution reconcile at epoch boundaries. If you're about to delegate or change a stake, knowing how far into the epoch we are helps timing.

### Stat cards (×6)

The "right now" snapshot of the network:

| Card | What it shows | How to read |
|------|---------------|-------------|
| **Latest Block** | Number of the most recent block (e.g. `#27,558,224`). | Always increasing. Used for cross-referencing transactions. |
| **TPS** | Transactions per second over the last 10 blocks. | Higher = more network activity. Empty traffic on testnet often shows 0.5–10 tps. |
| **Gas Price** | Current gas price in **gwei** (1 gwei = 10⁻⁹ MON). | Low (~50–100 gwei on testnet) means cheap to transact; spikes mean congestion. |
| **Block Time** | Average seconds between blocks over the last 10 blocks. | Monad targets **~0.4s**. >1s sustained means the network is slow. |
| **Tx in last block** | Transaction count in the most recently produced block. | Highly variable — testnet idle blocks have 0–5 tx; busy blocks have 50+. |
| **Block Utilization** | What percentage of the gas limit was used. `100% × gas_used / gas_limit`. | High (≥75%) = blocks are full, transactions queue and gas price rises. Low = headroom. |

### Parallel Execution panel

Monad's distinguishing feature is **parallel transaction execution** via OCC. This panel measures how well that's working.

#### KPI cards (×6)

| KPI | Definition | Interpretation |
|-----|------------|----------------|
| **retry_pct avg** | Average percentage of transactions re-executed per block due to OCC conflicts in the selected time window. | 0% = perfect parallelism; 50% = half of all tx conflict and get retried. Lower is better but ≠ 0 in practice. |
| **retry_pct peak** | The single worst block's retry percentage in the window. | Indicates if there have been heavy contention spikes. |
| **blocks with retries** | Percentage of blocks in the window that had at least one retried transaction. | A high number (e.g. 78%) is normal for active testnet — most blocks have at least minor conflicts. |
| **effective TPS peak** | The highest extrapolated TPS observed inside any single block. Computed as `tx / block_exec_time`. | Bursts of 100,000+ effective TPS are typical on Monad — that's the parallelism upside. |
| **gas/sec peak** | Highest gas consumed per second inside one block. | Pure throughput indicator. |
| **block exec avg** | Mean wall time to execute one block, in milliseconds. | Should stay <5ms; >10ms suggests disk contention or heavy load. |

p95 (95th-percentile) shown under retry_pct avg gives a sense of "worst case I should expect 1-in-20 of the time".

#### Charts (×2)

| Chart | What's shown | Color thresholds |
|-------|--------------|------------------|
| **Retry % per block** | One bar = one block. Bar height = `retry_pct` for that block. | 🟢 <25% / 🟡 25–65% / 🟠 65–75% / 🔴 ≥75%. |
| **Block execution time breakdown** | Same x-axis. Each bar split into three stacked segments: `state_reset` (blue), `tx_exec` (gold), `commit` (orange). Segment heights in microseconds. | If `commit` (orange) starts dominating, disk I/O is the bottleneck. If `tx_exec` (gold) dominates, you're CPU-bound on transaction execution. |

**Source:** `__exec_block` log lines emitted by Monad's execution layer, parsed from local Loki.

### Top Contracts by Retry Rate

Tabular list of which smart contracts caused the most retries in the selected window. Columns:

| Column | Meaning |
|--------|---------|
| **Address** | Contract address. Click to copy. |
| **Blocks** | Number of blocks this contract appeared in. |
| **Retried %** | Of those blocks, how many had retries attributable to this contract (proportional). |
| **Tx count** | Total transactions to this contract in the window. |

Filters: minimum-blocks threshold (avoid single-block coincidences), result limit, and time window selector.

**Why useful:** A contract with high retry % is a hot conflict point — many users hammer it concurrently. dApp developers should learn from these to avoid contention patterns (e.g. shared counters).

### Transactions per Second / Gas Price / Block Utilization chart

Time-series chart with three modes (toggle via TPS / GAS / UTIL buttons):

| Mode | Source | Y-axis unit |
|------|--------|-------------|
| **TPS** | Per-second TPS collector ring buffer (data refreshes every 1s) | tx/sec |
| **GAS** | InfluxDB `monad_chain.gas_gwei` (data from `/api/stats` poller) | gwei |
| **UTIL** | InfluxDB `monad_chain.block_util_pct` | % |

Range buttons: `5m` / `15m` / `1h` / `6h` / `12h` / `24h` — selects the time window. Each bar is one bucket (1s, 1min, 5min, etc. depending on range). The brush at the bottom allows selecting a sub-range to zoom.

UTIL bars use threshold coloring: <45% gold / 45–75% amber / ≥75% red.

### Latest Blocks

Most recent 20 blocks. Click any block number to open its full detail page.

| Column | Meaning |
|--------|---------|
| **Block** | Block height. |
| **Time** | Relative timestamp (e.g. "3s ago"). |
| **Tx** | Transaction count in the block. |
| **Gas Used / Limit** | Gas consumed / max allowed in this block. |
| **Miner / Validator** | Address of the validator that produced this block. Click to view that validator. |

### Latest Transactions

Recent transactions across the latest blocks. Includes a search box (paste a transaction hash to look it up).

| Column | Meaning |
|--------|---------|
| **Hash** | Unique transaction ID (`0x...`). Click to view. |
| **From** | Sender address. |
| **To** | Recipient or contract address (empty = contract creation). |
| **Value** | Amount of MON transferred. |
| **Block** | Block this transaction was included in. |
| **Gas Price** | Price the sender bid in gwei. |

---

## Validators page

URL: `/validators`

A sortable, searchable table of all known validators (314 total at the time of writing, ~200 in the active set).

### Columns

| Column | Meaning |
|--------|---------|
| **Moniker** | Human-readable name (from the `monad-developers/validator-info` GitHub registry, fallback to truncated address). |
| **Address** | Validator's `auth_address` (or `block.miner` for unregistered signers — see below). |
| **Stake** | Total MON staked = self-stake + delegations. Read from the on-chain staking precompile. |
| **Score** | Composite health score (0–100). See [Score formula](#validator-score-formula). |
| **Blocks (window)** | Blocks produced by this validator in the sample window (~6–7 minutes of history at default config). |
| **Last block** | Block number of this validator's most recently produced block. |
| **Status** | One of: `active` (recently produced), `slow` (lagging), `missing` (silent for too long). |

### Validator score formula

Each validator gets a score in `[0, 100]`. Inputs:

1. **Block production rate** — blocks produced / expected blocks for their stake share.
2. **Recency** — seconds since last block (younger = better).
3. **Registration** — validators not matched to an `auth_address` get a 0.7× penalty (we can verify they produce blocks, but cannot verify their stake backing).

`active` requires `last block age <156s`. `slow` is older than that but still recent. `missing` is essentially silent.

### Filters and toggles

| Control | Effect |
|---------|--------|
| **REGISTERED ONLY** checkbox | Hide unregistered signers (block producers we cannot link to a registered stake). |
| **Search** | Match on moniker or address (case-insensitive). |
| **Network** dropdown | Only `testnet` is active. Mainnet pending. |
| **Sort** | Click column headers — toggles asc/desc. |
| **RESET COLUMNS** | Restore default sort. |

### Per-validator page

Clicking any validator opens `/validators/[address]` with:

- Full address, moniker, total stake, commission, score
- Block production history chart
- Uptime trend (where available)
- Delegators panel (mainnet feature — populated when delegators exist; testnet shows the Foundation auto-distribution)

---

## Network Health page

URL: `/network`

Deep view of network-wide decentralization.

### Decentralization summary

| Metric | What it means |
|--------|---------------|
| **Total validators** | Registered count (`activeCount + registeredCount` from chain). |
| **Active validators** | Currently in the producing set. |
| **Total stake (MON)** | Sum of all validator stakes. |
| **Nakamoto coefficient — 33% / 50% / 66%** | Minimum number of validators that together hold ≥X% of stake. The smaller this number, the more centralized: e.g. `33% threshold = 5` means 5 validators colluding could halt block production. Higher is healthier. |
| **Top-10 share %** | Percentage of total stake held by the top 10 validators. |

### Top-10 validators by stake

Table with address, moniker, stake (MON), and `share %`.

### Validator set changes

Append-only feed of:

- `added` — a new validator joined the registered set.
- `removed` — a validator left.
- `stake_decrease` — a validator's stake dropped by more than 1000 MON (could indicate slashing).

### Reorgs feed

Detected chain reorganizations. Columns: timestamp, block number, depth, old hash → new hash.

Most reorgs are depth 1–3 and routine; deeper reorgs warrant investigation.

### Peer geo / ASN distribution

| Metric | Meaning |
|--------|---------|
| **By country** | Top countries hosting peers (extracted from journald `remote_addr` log lines, geolocated via ip-api.com). |
| **By ASN** | Top hosting providers / autonomous systems. e.g. `AS16276 OVH` 17%, `AS24940 Hetzner` 10%, etc. |

**Why this matters:** If 30%+ of the network sits on one ASN, a single provider outage can take down a significant chunk of the network simultaneously.

---

## Incidents page

URL: `/incidents`

Chronological feed of detected anomalies, persisted across server restarts.

### Severity legend

| Severity | Color | Meaning |
|----------|-------|---------|
| `info` | blue | Notable but expected event |
| `warn` | amber | Watch — not immediately critical |
| `critical` | red | Investigate immediately |

### Incident types

**Standard observers** (sample-based, on-chain or log-based):

| Icon | Type | What it means |
|------|------|---------------|
| ↺ | **reorg** | Chain reorg detected. Severity scales with depth. |
| + | **validator_added** | New validator registered. |
| × | **validator_removed** | Validator left the set. |
| ↓ | **stake_decrease** | Validator stake dropped by >1000 MON. Possible slashing. |
| ↯ | **retry_spike** | A block had retry_pct ≥90% and tx ≥5 — heavy contention burst. |
| ⏸ | **block_stall** | Block-to-block gap >3s (warn) or >10s (critical). The chain paused. |
| ! | **critical_log** | A critical log line emitted by a validator (panic, OOM, chunk-exhaustion, etc.). |

**Anomaly detectors** (edge-triggered, Monad-specific, our validator only):

| Icon | Type | What it means |
|------|------|---------------|
| ⊗ | **state_root_mismatch** | Local node received a block whose state-root doesn't match locally computed. Indicates execution-layer divergence (critical). |
| ⟳ | **state_sync_active** | `monad_statesync_syncing` gauge transitioned 0→1 (critical — node not validating) or 1→0 (info — recovered). |
| ⚡ | **consensus_stress** | Rolling 5-min ratio of rounds entered via TC (timeout certificate) vs QC (happy-path quorum) ≥ 20%. Healthy networks stay <5%. |
| ⏱ | **vote_delay_high** | `monad_state_vote_delay_p99_ms` > 300ms sustained for 5 ticks (~2.5min). CPU saturation, mesh latency, or storage contention. |
| ↧ | **tip_lag** | Local execution head is > 5 blocks behind reference RPC for 90s+. Possible state-sync, mesh issue, or execution lag. |

### Filters

- **Range:** `1h` / `6h` / `12h` / `24h` / `7d`
- **Severity:** `all` / `info` / `warn` / `critical`

Each item expands to show details (block numbers, addresses, raw log line, etc.).

---

## BeeHive page

URL: `/beehive`

Operator-specific landing for our own validator (BeeHive). Used as a delegation funnel.

| Block | What it shows |
|-------|---------------|
| **Hero** | BeeHive logo, name, status badge (`healthy` / `stale` / `awaiting delegation`). |
| **KPI cards** | Client version, our block height (with `✓ in-sync` if matching network tip), peer count, blocks/transactions our node has committed, configured commission. |
| **Why BeeHive** | 5-point sales pitch. |
| **Contact** | Twitter, Discord (click to copy username), website links. |

When `BEEHIVE_VALIDATOR_ADDRESS` env var is set (post-activation), commission and delegation details replace the "Awaiting Delegation" banner.

---

## API endpoints

All read-only. JSON responses. Default cache: short s-maxage with stale-while-revalidate.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/stats?network=testnet` | Current snapshot — block, gas, TPS, health, epoch. |
| `GET /api/blocks?network=testnet&count=20` | Recent blocks. |
| `GET /api/transactions?network=testnet` | Recent transactions across recent blocks. |
| `GET /api/history?range={5m..24h}` | Time-series of CPU/mem/TPS/gas/utilization (combined Influx series). |
| `GET /api/tps-timeline?range={5m..24h}` | Per-second TPS bars from in-memory ring buffer. |
| `GET /api/exec-stats?range={5m..7d}` | Parallel-execution metrics: KPIs + per-block points. Loki for ≤15min, InfluxDB for longer. |
| `GET /api/top-contracts?window={5m,15m,1h}&min=N&limit=N` | Hot contracts by retry rate. |
| `GET /api/validators?network=testnet` | Validator list with stats and scores. |
| `GET /api/validators/{address}` | Per-validator detail. |
| `GET /api/network-health` | Decentralization summary, Nakamoto coefficient, geo. |
| `GET /api/incidents?range={1h..7d}&severity={all,critical,warn,info}` | Incident feed. |
| `GET /api/beehive` | Live state of the BeeHive validator. |
| `GET /api/block/{number}` | Block detail. |
| `GET /api/tx/{hash}` | Transaction detail. |

The `/node` endpoint and its sub-routes are HTTP-Basic-auth protected (operator-only).

---

## Data sources

| Source | What we read | Purpose |
|--------|--------------|---------|
| **Local Monad RPC** (`http://15.235.117.52:8080`) | `eth_blockNumber`, `eth_getBlockByNumber`, staking precompile | Chain state and validators. |
| **Loki** (`http://127.0.0.1:3100`) | journald logs from monad-bft, monad-execution, monad-rpc | Logs, `__exec_block` parsing, peer IPs, critical-log detection. |
| **InfluxDB 1.x** (`https://localhost:8086`, db `monad`) | Persisted metrics: `monad_chain`, `monad_exec`, `monad_reorgs`, `monad_valset_changes` | Long-range history (>15min Loki window). |
| **otelcol Prometheus** (`http://15.235.117.52:8889/metrics`) | Validator's own metrics export | Resource usage, peer counts, version. |
| **GitHub** (`category-labs/monad-bft` releases) | Latest release tag | Client version comparison. |
| **ip-api.com** | Peer IP → country / ASN | Geo distribution. |

---

## License

MIT. See [LICENSE](../LICENSE).

## Feedback

Issues and PRs welcome. Twitter [@BeeHive_NT](https://twitter.com/BeeHive_NT).
