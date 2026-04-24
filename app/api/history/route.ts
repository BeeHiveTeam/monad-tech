import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

const RANGE_CONFIG: Record<string, { duration: string; interval: string }> = {
  '5m':  { duration: '5m',  interval: '10s' },
  '15m': { duration: '15m', interval: '30s' },
  '1h':  { duration: '1h',  interval: '1m'  },
  '6h':  { duration: '6h',  interval: '5m'  },
  '12h': { duration: '12h', interval: '10m' },
  '24h': { duration: '24h', interval: '15m' },
};

function msToInfluxInterval(ms: number): string {
  if (ms <= 30 * 60_000)  return '30s';
  if (ms <= 3 * 3600_000) return '1m';
  if (ms <= 12 * 3600_000) return '5m';
  if (ms <= 48 * 3600_000) return '15m';
  return '30m';
}

async function queryInflux(q: string): Promise<unknown[][]> {
  const res = await fetch(
    `${INFLUX_URL}/query?db=${INFLUX_DB}&q=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) return [];
  const json = await res.json() as {
    results: Array<{ series?: Array<{ values?: unknown[][] }> }>
  };
  return json.results?.[0]?.series?.[0]?.values ?? [];
}

export interface HistoryPoint {
  ts: number;    // unix ms
  time: string;  // formatted label
  cpu: number | null;
  mem: number | null;
  tps: number | null;
  gas: number | null;
  util: number | null;
}

function fmtTime(iso: string, range: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  if (range === '5m' || range === '15m' || range === '1h') return `${hh}:${mm}:${ss}`;
  return `${hh}:${mm}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const range = sp.get('range') ?? '15m';
  const startMs = sp.get('start') ? Number(sp.get('start')) : null;
  const endMs   = sp.get('end')   ? Number(sp.get('end'))   : null;

  let timeWhere: string;
  let interval: string;
  let effectiveRange: string;

  if (startMs && endMs && isFinite(startMs) && isFinite(endMs)) {
    const durationMs = endMs - startMs;
    interval = msToInfluxInterval(durationMs);
    // InfluxDB 1.x epoch is nanoseconds; ms × 1_000_000
    timeWhere = `time >= ${startMs}ms AND time <= ${endMs}ms`;
    effectiveRange = 'custom';
  } else {
    const cfg = RANGE_CONFIG[range] ?? RANGE_CONFIG['15m'];
    interval = cfg.interval;
    timeWhere = `time > now()-${cfg.duration}`;
    effectiveRange = range;
  }

  try {
    const [sysRows, chainRows] = await Promise.all([
      queryInflux(
        `SELECT mean(cpu_load_pct), mean(mem_used_pct) FROM monad_system ` +
        `WHERE ${timeWhere} GROUP BY time(${interval}) fill(previous)`
      ),
      queryInflux(
        `SELECT mean(tps), mean(gas_gwei), mean(block_util_pct) FROM monad_chain ` +
        `WHERE ${timeWhere} GROUP BY time(${interval}) fill(previous)`
      ),
    ]);

    const byTs = new Map<string, HistoryPoint>();
    const ensure = (iso: string): HistoryPoint => {
      let p = byTs.get(iso);
      if (!p) {
        p = {
          ts: new Date(iso).getTime(),
          time: fmtTime(iso, range),
          cpu: null, mem: null, tps: null, gas: null, util: null,
        };
        byTs.set(iso, p);
      }
      return p;
    };
    for (const r of sysRows) {
      const iso = r[0] as string;
      const p = ensure(iso);
      if (r[1] != null) p.cpu = parseFloat((r[1] as number).toFixed(2));
      if (r[2] != null) p.mem = parseFloat((r[2] as number).toFixed(2));
    }
    for (const r of chainRows) {
      const iso = r[0] as string;
      const p = ensure(iso);
      if (r[1] != null) p.tps = parseFloat((r[1] as number).toFixed(2));
      if (r[2] != null) p.gas = parseFloat((r[2] as number).toFixed(3));
      if (r[3] != null) p.util = parseFloat((r[3] as number).toFixed(2));
    }
    const points = Array.from(byTs.values())
      .filter(p => p.cpu != null || p.mem != null || p.tps != null || p.gas != null || p.util != null)
      .sort((a, b) => a.ts - b.ts);

    return NextResponse.json({ points, range: effectiveRange });
  } catch (err) {
    return NextResponse.json({ points: [], range, error: String(err) });
  }
}
