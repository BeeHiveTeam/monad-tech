import { NextResponse } from 'next/server';
import { getBlockNumber } from '@/lib/rpc';
import { parsePrometheus, findOne, findAll, sumBy } from '@/lib/prom-parser';

export const dynamic = 'force-dynamic';

const METRICS_URL = process.env.NODE_METRICS_URL || 'http://15.235.117.52:8889/metrics';
const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';
const CACHE_TTL_MS = 10_000;

const WINDOWS: Array<{ key: string; ms: number }> = [
  { key: '5m',  ms: 5 * 60_000 },
  { key: '15m', ms: 15 * 60_000 },
  { key: '1h',  ms: 60 * 60_000 },
  { key: '6h',  ms: 6 * 60 * 60_000 },
  { key: '12h', ms: 12 * 60 * 60_000 },
  { key: '24h', ms: 24 * 60 * 60_000 },
];

// ─── Service taxonomy ───────────────────────────────────────────────────────
// Detect liveness per logical systemd unit based on which Prometheus prefixes
// appear in the scrape and how fresh their sample timestamps are.
interface ServiceDef {
  key: 'monad' | 'monad-execution' | 'monad-bft' | 'monad-rpc';
  label: string;
  description: string;
  // A sample counts as belonging to the service if its name starts with any prefix.
  prefixes: string[];
  // Optional job label to tighten matching (monad-rpc registers under a different job).
  jobs?: string[];
}
const SERVICES: ServiceDef[] = [
  {
    key: 'monad',
    label: 'monad',
    description: 'Core node daemon (peer discovery, raptorcast, wireauth, uptime)',
    prefixes: [
      'monad_node_info', 'monad_total_uptime', 'monad_peer_disc_',
      'monad_raptorcast_', 'monad_wireauth_',
    ],
  },
  {
    key: 'monad-execution',
    label: 'monad-execution',
    description: 'Execution engine (ledger, executor, block commits)',
    prefixes: ['monad_execution_', 'monad_executor_'],
  },
  {
    key: 'monad-bft',
    label: 'monad-bft',
    description: 'Consensus / BFT (state, vote, blocktree, statesync)',
    prefixes: [
      'monad_bft_', 'monad_state_consensus', 'monad_state_vote',
      'monad_state_blocksync', 'monad_state_blocktree', 'monad_state_validation',
      'monad_state_node', 'monad_state_total', 'monad_statesync_',
    ],
  },
  {
    key: 'monad-rpc',
    label: 'monad-rpc',
    description: 'JSON-RPC server (eth_* endpoints)',
    prefixes: ['monad_rpc_'],
    jobs: ['BeeHive'],
  },
];

// ─── Error category taxonomy ────────────────────────────────────────────────
// Each category is a group shown on the dashboard; each subtype is an
// individual Prometheus counter that rolls up into the group total.
// `field` is the InfluxDB column (stable — changing it breaks historical deltas).
interface Subtype { key: string; field: string; metric: string; label: string; }
interface Category { key: 'blocksync' | 'consensus' | 'validation' | 'network'; label: string; help: string; subtypes: Subtype[]; }

const CATEGORIES: Category[] = [
  {
    key: 'blocksync',
    label: 'Blocksync failures',
    help: 'peer/self headers, payload, timeouts',
    subtypes: [
      { key: 'peer_headers',      field: 'bs_peer_headers',      metric: 'monad_state_blocksync_events_peer_headers_request_failed',  label: 'Peer headers request failed' },
      { key: 'peer_payload',      field: 'bs_peer_payload',      metric: 'monad_state_blocksync_events_peer_payload_request_failed',  label: 'Peer payload request failed' },
      { key: 'req_timeout',       field: 'bs_req_timeout',       metric: 'monad_state_blocksync_events_request_timeout',              label: 'Request timeout' },
      { key: 'req_no_peers',      field: 'bs_req_no_peers',      metric: 'monad_state_blocksync_events_request_failed_no_peers',      label: 'Request failed (no peers)' },
      { key: 'headers_val_fail',  field: 'bs_headers_val_fail',  metric: 'monad_state_blocksync_events_headers_validation_failed',    label: 'Headers validation failed' },
      { key: 'headers_resp_fail', field: 'bs_headers_resp_fail', metric: 'monad_state_blocksync_events_headers_response_failed',      label: 'Headers response failed' },
      { key: 'payload_resp_fail', field: 'bs_payload_resp_fail', metric: 'monad_state_blocksync_events_payload_response_failed',      label: 'Payload response failed' },
    ],
  },
  {
    key: 'consensus',
    label: 'Consensus anomalies',
    help: 'local timeouts, TCs, validation fail',
    subtypes: [
      { key: 'failed_ts_val',           field: 'cs_failed_ts_val',          metric: 'monad_state_consensus_events_failed_ts_validation',            label: 'Failed timestamp validation' },
      { key: 'failed_txn_val',          field: 'cs_failed_txn_val',         metric: 'monad_state_consensus_events_failed_txn_validation',           label: 'Failed txn validation' },
      { key: 'failed_randao',           field: 'cs_failed_randao',          metric: 'monad_state_consensus_events_failed_verify_randao_reveal_sig', label: 'Failed RANDAO reveal sig' },
      { key: 'invalid_proposal_leader', field: 'cs_inv_proposal_leader',    metric: 'monad_state_consensus_events_invalid_proposal_round_leader',   label: 'Invalid proposal round leader' },
      { key: 'invalid_recovery_leader', field: 'cs_inv_recovery_leader',    metric: 'monad_state_consensus_events_invalid_round_recovery_leader',   label: 'Invalid round recovery leader' },
      { key: 'local_timeout',           field: 'cs_local_timeout',          metric: 'monad_state_consensus_events_local_timeout',                   label: 'Local timeout' },
      { key: 'rx_base_fee',             field: 'cs_rx_base_fee',            metric: 'monad_state_consensus_events_rx_base_fee_error',               label: 'RX base fee error' },
      { key: 'created_tc',              field: 'cs_created_tc',             metric: 'monad_state_consensus_events_created_tc',                      label: 'Timeout certificate created' },
    ],
  },
  {
    key: 'validation',
    label: 'Validation errors',
    help: 'bad sig / round / epoch / author',
    subtypes: [
      { key: 'dup_tc_tip_round',    field: 'val_dup_tc_tip',          metric: 'monad_state_validation_errors_duplicate_tc_tip_round',        label: 'Duplicate TC tip round' },
      { key: 'empty_signers_tc',    field: 'val_empty_signers_tc',    metric: 'monad_state_validation_errors_empty_signers_tc_tip_round',    label: 'Empty signers (TC tip)' },
      { key: 'insufficient_stake',  field: 'val_insufficient_stake',  metric: 'monad_state_validation_errors_insufficient_stake',            label: 'Insufficient stake' },
      { key: 'invalid_author',      field: 'val_invalid_author',      metric: 'monad_state_validation_errors_invalid_author',                label: 'Invalid author' },
      { key: 'invalid_epoch',       field: 'val_invalid_epoch',       metric: 'monad_state_validation_errors_invalid_epoch',                 label: 'Invalid epoch' },
      { key: 'invalid_seq_num',     field: 'val_invalid_seq_num',     metric: 'monad_state_validation_errors_invalid_seq_num',               label: 'Invalid seq num' },
      { key: 'invalid_sig',         field: 'val_invalid_sig',         metric: 'monad_state_validation_errors_invalid_signature',             label: 'Invalid signature' },
      { key: 'invalid_tc_round',    field: 'val_invalid_tc_round',    metric: 'monad_state_validation_errors_invalid_tc_round',              label: 'Invalid TC round' },
      { key: 'invalid_version',     field: 'val_invalid_version',     metric: 'monad_state_validation_errors_invalid_version',               label: 'Invalid version' },
      { key: 'invalid_vote_msg',    field: 'val_invalid_vote_msg',    metric: 'monad_state_validation_errors_invalid_vote_message',          label: 'Invalid vote message' },
      { key: 'not_well_formed_sig', field: 'val_malformed_sig',       metric: 'monad_state_validation_errors_not_well_formed_sig',           label: 'Malformed signature' },
      { key: 'sigs_dup_node',       field: 'val_sigs_dup_node',       metric: 'monad_state_validation_errors_signatures_duplicate_node',     label: 'Duplicate-node signatures' },
      { key: 'too_many_tc_tip',     field: 'val_too_many_tc_tip',     metric: 'monad_state_validation_errors_too_many_tc_tip_round',         label: 'Too many TC tip round' },
      { key: 'val_data_unavail',    field: 'val_data_unavail',        metric: 'monad_state_validation_errors_val_data_unavailable',          label: 'Validator data unavailable' },
    ],
  },
  {
    key: 'network',
    label: 'Network drops',
    help: 'drop/timeout/decrypt/raptorcast rx',
    subtypes: [
      { key: 'drop_ping',      field: 'net_drop_ping',      metric: 'monad_peer_disc_drop_ping',             label: 'Drop ping' },
      { key: 'drop_pong',      field: 'net_drop_pong',      metric: 'monad_peer_disc_drop_pong',             label: 'Drop pong' },
      { key: 'lookup_timeout', field: 'net_lookup_timeout', metric: 'monad_peer_disc_lookup_timeout',        label: 'Lookup timeout' },
      { key: 'ping_timeout',   field: 'net_ping_timeout',   metric: 'monad_peer_disc_ping_timeout',          label: 'Ping timeout' },
      { key: 'rc_recv_err',    field: 'net_rc_recv_err',    metric: 'monad_raptorcast_total_recv_errors',    label: 'Raptorcast recv errors' },
      { key: 'udp_decrypt',    field: 'net_udp_decrypt',    metric: 'monad_wireauth_udp_error_decrypt',      label: 'UDP decrypt error' },
    ],
  },
];

let cache: { ts: number; data: unknown } | null = null;

// ─── InfluxDB helpers ────────────────────────────────────────────────────────

async function influxWrite(lines: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      body: lines,
      signal: AbortSignal.timeout(3000),
      // @ts-expect-error: node fetch rejectUnauthorized
      dispatcher: undefined,
    });
  } catch {
    // non-critical: don't fail the main request if InfluxDB is down
  }
}

async function influxQuery(q: string): Promise<unknown[] | null> {
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      results: Array<{ series?: Array<{ values?: unknown[][] }> }>
    };
    return json.results?.[0]?.series?.[0]?.values ?? null;
  } catch {
    return null;
  }
}

interface SubtypeDelta {
  key: string;
  field: string; // InfluxDB field name — also the query key for the timeline endpoint
  label: string;
  total: number;  // lifetime counter value
  delta: number;  // increase within the window
}
interface EventDelta {
  blocksync: number;
  consensus: number;
  validation: number;
  network: number;
  coverageSec: number;
  breakdown: {
    blocksync:  SubtypeDelta[];
    consensus:  SubtypeDelta[];
    validation: SubtypeDelta[];
    network:    SubtypeDelta[];
  };
}

async function influxFirstRow(windowSec: number): Promise<Record<string, unknown> | null> {
  // SELECT FIRST(*) returns a single row with columns: time, first_<field1>, first_<field2>, ...
  // We also need the columns in the response to map field names — use a raw query path.
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(
        `SELECT FIRST(*) FROM monad_events WHERE time > now()-${windowSec}s`
      )}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>
    };
    const series = json.results?.[0]?.series?.[0];
    if (!series?.values?.length) return null;
    const cols = series.columns;
    const row = series.values[0];
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  } catch {
    return null;
  }
}

async function deltaForWindow(windowMs: number, current: {
  blocksync: number; consensus: number; validation: number; network: number;
  subtypes: Record<string, number>;
}): Promise<EventDelta | null> {
  const windowSec = Math.round(windowMs / 1000);
  const base = await influxFirstRow(windowSec);
  if (!base) return null;
  const baseTs = base.time as string | undefined;
  if (!baseTs) return null;

  const baseTime = new Date(baseTs).getTime();
  const coverageMs = Date.now() - baseTime;
  if (coverageMs < windowMs * 0.8) return null;

  const baseAt = (field: string): number => {
    const v = base[`first_${field}`];
    return typeof v === 'number' ? v : 0;
  };

  const breakdown = {} as EventDelta['breakdown'];
  for (const cat of CATEGORIES) {
    breakdown[cat.key] = cat.subtypes.map(st => ({
      key: st.key,
      field: st.field,
      label: st.label,
      total: current.subtypes[st.field] ?? 0,
      delta: Math.max(0, (current.subtypes[st.field] ?? 0) - baseAt(st.field)),
    }));
  }

  return {
    blocksync:  Math.max(0, current.blocksync  - baseAt('blocksync')),
    consensus:  Math.max(0, current.consensus  - baseAt('consensus')),
    validation: Math.max(0, current.validation - baseAt('validation')),
    network:    Math.max(0, current.network    - baseAt('network')),
    coverageSec: Math.round(coverageMs / 1000),
    breakdown,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const startedAt = Date.now();

  try {
    const [metricsRes, tipNum] = await Promise.allSettled([
      fetch(METRICS_URL, { signal: AbortSignal.timeout(6000) }),
      getBlockNumber('testnet'),
    ]);

    if (metricsRes.status !== 'fulfilled' || !metricsRes.value.ok) {
      throw new Error(
        metricsRes.status === 'rejected'
          ? String(metricsRes.reason)
          : `HTTP ${metricsRes.value.status}`,
      );
    }

    const text = await metricsRes.value.text();
    const samples = parsePrometheus(text);

    // ───── node info ─────
    const nodeInfo = findOne(samples, 'monad_node_info');
    const service = nodeInfo?.labels.service_name || nodeInfo?.labels.job || 'unknown';
    const version = nodeInfo?.labels.service_version || '?';
    const network = nodeInfo?.labels.network || '?';

    // ───── block / sync ─────
    const blockNum = findOne(samples, 'monad_execution_ledger_block_num')?.value ?? 0;
    const totalCommits = findOne(samples, 'monad_execution_ledger_num_commits')?.value ?? 0;
    const totalTxCommits = findOne(samples, 'monad_execution_ledger_num_tx_commits')?.value ?? 0;

    const testnetTip = tipNum.status === 'fulfilled' ? Number(tipNum.value) : 0;
    const tipKnown = testnetTip > 0;
    const lagBlocks = tipKnown ? Math.abs(testnetTip - blockNum) : 0;
    const synced = !tipKnown || lagBlocks < 30;

    // ───── peers ─────
    const peers = findOne(samples, 'monad_peer_disc_num_peers')?.value ?? 0;
    const pendingPeers = findOne(samples, 'monad_peer_disc_num_pending_peers')?.value ?? 0;
    const upstreamValidators = findOne(samples, 'monad_peer_disc_num_upstream_validators')?.value ?? 0;

    // ───── traffic ─────
    const rxBytes = findOne(samples, 'monad_raptorcast_auth_authenticated_udp_bytes_read')?.value ?? 0;
    const txBytes = findOne(samples, 'monad_raptorcast_auth_authenticated_udp_bytes_written')?.value ?? 0;

    // ───── event counters ─────
    // For each category, read every sub-counter individually; sum → category total.
    const subtypeValues: Record<string, number> = {};
    const catTotals: Record<Category['key'], number> = { blocksync: 0, consensus: 0, validation: 0, network: 0 };
    for (const cat of CATEGORIES) {
      let sum = 0;
      for (const st of cat.subtypes) {
        const v = sumBy(samples, st.metric);
        subtypeValues[st.field] = v;
        sum += v;
      }
      catTotals[cat.key] = sum;
    }
    const blocksyncFailures   = catTotals.blocksync;
    const consensusAnomalies  = catTotals.consensus;
    const validationErrors    = catTotals.validation;
    const networkDrops        = catTotals.network;

    // ───── system: CPU ─────
    const load1 = findOne(samples, 'system_cpu_load_average_1m')?.value ?? 0;
    const load5 = findOne(samples, 'system_cpu_load_average_5m')?.value ?? 0;
    const load15 = findOne(samples, 'system_cpu_load_average_15m')?.value ?? 0;

    const cpuSet = new Set<string>();
    for (const s of findAll(samples, 'system_cpu_time_seconds_total')) {
      if (s.labels.cpu) cpuSet.add(s.labels.cpu);
    }
    const cpuCount = cpuSet.size || 1;
    const cpuLoadPct = Math.min(100, (load1 / cpuCount) * 100);

    // ───── system: memory ─────
    const memUsedBytes = findOne(samples, 'system_memory_usage_bytes', l => l.state === 'used')?.value ?? 0;
    const memTotalBytes = sumBy(samples, 'system_memory_usage_bytes');
    const memUsedPct = memTotalBytes > 0 ? (memUsedBytes / memTotalBytes) * 100 : 0;

    // ───── system: swap ─────
    const swapUsedBytes = findAll(samples, 'system_paging_usage_bytes')
      .filter(s => s.labels.state === 'used')
      .reduce((acc, s) => acc + s.value, 0);
    const swapFreeBytes = findAll(samples, 'system_paging_usage_bytes')
      .filter(s => s.labels.state === 'free')
      .reduce((acc, s) => acc + s.value, 0);
    const swapTotalBytes = swapUsedBytes + swapFreeBytes;
    const swapUsedPct = swapTotalBytes > 0 ? (swapUsedBytes / swapTotalBytes) * 100 : 0;

    // ───── system: disks ─────
    const fsSamples = findAll(samples, 'system_filesystem_usage_bytes');
    const fsByMount = new Map<string, { device: string; type: string; used: number; free: number; reserved: number }>();
    for (const s of fsSamples) {
      const mp = s.labels.mountpoint;
      if (!mp) continue;
      const entry = fsByMount.get(mp) ?? { device: s.labels.device ?? '', type: s.labels.type ?? '', used: 0, free: 0, reserved: 0 };
      if (s.labels.state === 'used') entry.used = s.value;
      else if (s.labels.state === 'free') entry.free = s.value;
      else if (s.labels.state === 'reserved') entry.reserved = s.value;
      fsByMount.set(mp, entry);
    }
    const disks = Array.from(fsByMount.entries()).map(([mountpoint, e]) => {
      const total = e.used + e.free + e.reserved;
      return { mountpoint, device: e.device, fsType: e.type, usedBytes: e.used, freeBytes: e.free, totalBytes: total, usedPct: total > 0 ? Math.round((e.used / total) * 1000) / 10 : 0 };
    }).sort((a, b) => b.totalBytes - a.totalBytes);

    // ───── services: derive status from metric prefix presence + freshness ─────
    const FRESH_MS = 30_000; // sample newer than this = service is live
    const nowForFreshness = Date.now();
    const services = SERVICES.map(sv => {
      let matched = 0;
      let latestTs = 0;
      for (const s of samples) {
        if (sv.jobs && !sv.jobs.includes(s.labels.job ?? '')) continue;
        if (!sv.prefixes.some(p => s.name.startsWith(p))) continue;
        matched++;
        if (s.timestampMs && s.timestampMs > latestTs) latestTs = s.timestampMs;
      }
      let status: 'running' | 'stale' | 'stopped';
      if (matched === 0) status = 'stopped';
      else if (latestTs === 0 || nowForFreshness - latestTs < FRESH_MS) status = 'running';
      else status = 'stale';
      const ageSec = latestTs ? Math.round((nowForFreshness - latestTs) / 1000) : null;

      // per-service key signals
      const signals: Record<string, number | null> = {};
      if (sv.key === 'monad') {
        const upSec = (findOne(samples, 'monad_total_uptime_us')?.value ?? 0) / 1e6;
        signals.uptimeSec = upSec > 0 ? Math.round(upSec) : null;
        signals.peers = peers;
      } else if (sv.key === 'monad-execution') {
        signals.block = blockNum || null;
        signals.commits = totalCommits || null;
      } else if (sv.key === 'monad-bft') {
        const commits = findOne(samples, 'monad_state_consensus_events_commit_block')?.value ?? 0;
        const votes = findOne(samples, 'monad_state_consensus_events_created_vote')?.value ?? 0;
        const roundsQc = findOne(samples, 'monad_state_consensus_events_enter_new_round_qc')?.value ?? 0;
        const roundsTc = findOne(samples, 'monad_state_consensus_events_enter_new_round_tc')?.value ?? 0;
        signals.commits = commits || null;
        signals.votes = votes || null;
        signals.rounds = (roundsQc + roundsTc) || null;
      } else if (sv.key === 'monad-rpc') {
        const active = findAll(samples, 'monad_rpc_active_requests')
          .reduce((a, s) => a + s.value, 0);
        const reqCount = findAll(samples, 'monad_rpc_request_duration_seconds_count')
          .reduce((a, s) => a + s.value, 0);
        signals.activeRequests = active;
        signals.totalRequests = reqCount || null;
      }

      return {
        key: sv.key,
        label: sv.label,
        description: sv.description,
        status,
        ageSec,
        metricsCount: matched,
        signals,
      };
    });

    // ───── system: network interfaces ─────
    const netByDevice = new Map<string, { rx: number; tx: number }>();
    for (const s of findAll(samples, 'system_network_io_bytes_total')) {
      const dev = s.labels.device;
      if (!dev) continue;
      const entry = netByDevice.get(dev) ?? { rx: 0, tx: 0 };
      if (s.labels.direction === 'receive') entry.rx = s.value;
      else if (s.labels.direction === 'transmit') entry.tx = s.value;
      netByDevice.set(dev, entry);
    }
    const networkIfaces = Array.from(netByDevice.entries())
      .filter(([, v]) => v.rx > 0 || v.tx > 0)
      .map(([device, v]) => ({ device, rxBytes: v.rx, txBytes: v.tx }))
      .sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes));

    // ───── write to InfluxDB (fire-and-forget) ─────
    const nowMs = Date.now();
    const systemLine =
      `monad_system cpu_load_pct=${cpuLoadPct},cpu_load1=${load1},cpu_load5=${load5},cpu_load15=${load15},` +
      `mem_used_pct=${memUsedPct},mem_used_bytes=${memUsedBytes}i,mem_total_bytes=${memTotalBytes}i,` +
      `swap_used_pct=${swapUsedPct},swap_used_bytes=${swapUsedBytes}i,swap_total_bytes=${swapTotalBytes}i ${nowMs}`;
    const subtypeFields = Object.entries(subtypeValues)
      .map(([k, v]) => `${k}=${v}i`)
      .join(',');
    const eventsLine =
      `monad_events blocksync=${blocksyncFailures}i,consensus=${consensusAnomalies}i,` +
      `validation=${validationErrors}i,network=${networkDrops}i,${subtypeFields} ${nowMs}`;
    const nodeLine =
      `monad_node block=${blockNum}i,lag=${lagBlocks}i,peers=${peers}i,` +
      `commits=${totalCommits}i,tx_commits=${totalTxCommits}i ${nowMs}`;

    // don't await — write in background
    influxWrite([systemLine, eventsLine, nodeLine].join('\n'));

    // ───── compute event windows from InfluxDB ─────
    const currentEvents = {
      blocksync: blocksyncFailures,
      consensus: consensusAnomalies,
      validation: validationErrors,
      network:   networkDrops,
      subtypes:  subtypeValues,
    };
    const windowResults = await Promise.all(
      WINDOWS.map(w => deltaForWindow(w.ms, currentEvents).then(d => [w.key, d] as const))
    );
    const eventWindows = Object.fromEntries(windowResults);

    // ───── health ─────
    let health: 'healthy' | 'degraded' | 'offline';
    let healthReason: string;
    if (tipKnown && !synced) {
      health = 'degraded';
      healthReason = `Out of sync — lagging ${lagBlocks.toLocaleString('en-US')} blocks behind tip`;
    } else if (peers < 10) {
      health = 'degraded';
      healthReason = `Low peer count: ${peers}`;
    } else if (cpuLoadPct > 90 || memUsedPct > 95) {
      health = 'degraded';
      healthReason = `High resource usage — CPU ${cpuLoadPct.toFixed(0)}% mem ${memUsedPct.toFixed(0)}%`;
    } else if (!tipKnown) {
      health = 'healthy';
      healthReason = 'Validator operating normally (public tip unavailable for comparison)';
    } else {
      health = 'healthy';
      healthReason = 'Validator synced and operating normally';
    }

    const data = {
      fetchedAt: nowMs,
      latencyMs: Date.now() - startedAt,
      source: METRICS_URL,
      node: {
        service, version, network,
        block: { latest: blockNum, testnetTip, lagBlocks, synced },
        peers: { total: peers, pending: pendingPeers, upstreamValidators },
        traffic: { rxBytes, txBytes },
        commits: { blocks: totalCommits, txs: totalTxCommits },
        events: { blocksyncFailures, consensusAnomalies, validationErrors, networkDrops },
        eventCategories: CATEGORIES.map(c => ({
          key: c.key, label: c.label, help: c.help,
          subtypes: c.subtypes.map(s => ({ key: s.key, label: s.label, field: s.field })),
        })),
        eventWindows,
        services,
      },
      system: {
        cpu: { load1, load5, load15, cores: cpuCount, loadPct: cpuLoadPct },
        memory: { usedBytes: memUsedBytes, totalBytes: memTotalBytes, usedPct: memUsedPct },
        swap: { usedBytes: swapUsedBytes, totalBytes: swapTotalBytes, usedPct: swapUsedPct },
        disks, network: networkIfaces,
      },
      health: { state: health, reason: healthReason },
    };

    cache = { ts: nowMs, data };
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({
      error: String(err),
      fetchedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      health: { state: 'offline', reason: `Metrics endpoint unreachable: ${String(err).slice(0, 120)}` },
    }, { status: 503 });
  }
}
