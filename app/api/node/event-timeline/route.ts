import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

// Whitelist of allowed InfluxDB fields. Must stay in sync with
// `CATEGORIES` in app/api/node/route.ts (bs_/cs_/val_/net_ prefixes).
// Acts as an injection guard since `field` is interpolated into a query.
const ALLOWED_FIELDS = new Set<string>([
  // blocksync
  'bs_peer_headers', 'bs_peer_payload', 'bs_req_timeout', 'bs_req_no_peers',
  'bs_headers_val_fail', 'bs_headers_resp_fail', 'bs_payload_resp_fail',
  // consensus
  'cs_failed_ts_val', 'cs_failed_txn_val', 'cs_failed_randao',
  'cs_inv_proposal_leader', 'cs_inv_recovery_leader',
  'cs_local_timeout', 'cs_rx_base_fee', 'cs_created_tc',
  // validation
  'val_dup_tc_tip', 'val_empty_signers_tc', 'val_insufficient_stake',
  'val_invalid_author', 'val_invalid_epoch', 'val_invalid_seq_num',
  'val_invalid_sig', 'val_invalid_tc_round', 'val_invalid_version',
  'val_invalid_vote_msg', 'val_malformed_sig', 'val_sigs_dup_node',
  'val_too_many_tc_tip', 'val_data_unavail',
  // network
  'net_drop_ping', 'net_drop_pong', 'net_lookup_timeout',
  'net_ping_timeout', 'net_rc_recv_err', 'net_udp_decrypt',
]);

const RANGE_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600,
  '6h': 21600, '12h': 43200, '24h': 86400,
};

interface TimelineEvent {
  ts: number;      // unix ms of the increment
  increment: number;
  total: number;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const field = searchParams.get('field') ?? '';
  const range = searchParams.get('range') ?? '1h';

  if (!ALLOWED_FIELDS.has(field)) {
    return NextResponse.json({ error: 'unknown field' }, { status: 400 });
  }
  const windowSec = RANGE_SECONDS[range];
  if (!windowSec) {
    return NextResponse.json({ error: 'unknown range' }, { status: 400 });
  }

  // Pull every sample within the window for this single field.
  const q = `SELECT time, "${field}" FROM monad_events WHERE time > now()-${windowSec}s ORDER BY time ASC`;
  try {
    const res = await fetch(
      `${INFLUX_URL}/query?db=${INFLUX_DB}&epoch=ms&q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      return NextResponse.json({ error: `influx ${res.status}` }, { status: 502 });
    }
    const json = await res.json() as {
      results: Array<{ series?: Array<{ columns: string[]; values: unknown[][] }> }>;
    };
    const series = json.results?.[0]?.series?.[0];
    if (!series?.values?.length) {
      return NextResponse.json({ events: [], samples: 0, field, range });
    }
    const timeIdx = series.columns.indexOf('time');
    const valueIdx = series.columns.indexOf(field);
    if (timeIdx < 0 || valueIdx < 0) {
      return NextResponse.json({ events: [], samples: 0, field, range });
    }

    // Compute increments between consecutive samples.
    const events: TimelineEvent[] = [];
    let prev: number | null = null;
    for (const row of series.values) {
      const ts = Number(row[timeIdx]);
      const val = Number(row[valueIdx]);
      if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
      if (prev !== null && val > prev) {
        events.push({ ts, increment: val - prev, total: val });
      }
      prev = val;
    }

    // Cap to most recent 500 increments to keep the payload small.
    const trimmed = events.slice(-500);
    return NextResponse.json({
      events: trimmed,
      samples: series.values.length,
      totalIncrements: events.length,
      field,
      range,
      note: 'Timestamps derived from 10s polling of Prometheus counter — resolution ≈ 10s. For raw log text, enable a journald HTTP endpoint on the validator.',
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
