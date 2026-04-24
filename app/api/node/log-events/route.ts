import { NextRequest, NextResponse } from 'next/server';
import { LOG_PATTERNS, matchLogLine, type LogAction } from '@/lib/logPatterns';

export const dynamic = 'force-dynamic';

const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';

const RANGE_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600,
  '6h': 21600, '12h': 43200, '24h': 86400,
};
const SERVICES = ['monad', 'monad-execution', 'monad-bft', 'monad-rpc'];

// In-memory cache — aggregates change slowly; TTL scales with range.
interface CacheEntry { ts: number; body: unknown; ttlMs: number; }
const cache = new Map<string, CacheEntry>();
function cacheGet(key: string): unknown | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttlMs) { cache.delete(key); return null; }
  return e.body;
}
function cacheSet(key: string, body: unknown, ttlMs: number) {
  cache.set(key, { ts: Date.now(), body, ttlMs });
  if (cache.size > 50) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// Parse outer journald envelope + nested JSON/plain-text.
// Used only for sampling examples (not for counting).
function parseLine(line: string): { message: string; level: string | null } {
  try {
    const outer = JSON.parse(line) as Record<string, string>;
    const msgStr = outer.MESSAGE;
    if (!msgStr) return { message: line, level: null };
    try {
      const inner = JSON.parse(msgStr) as {
        level?: string;
        fields?: { message?: string };
        message?: string;
      };
      const m = inner.fields?.message ?? inner.message ?? msgStr;
      return { message: String(m), level: inner.level?.toUpperCase() ?? null };
    } catch {
      const lvlM = msgStr.match(/\bLOG_(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/);
      const level = lvlM
        ? lvlM[1].replace('WARNING', 'WARN').replace('CRITICAL', 'FATAL')
        : null;
      const tab = msgStr.indexOf('\t');
      return { message: tab >= 0 ? msgStr.slice(tab + 1) : msgStr, level };
    }
  } catch {
    return { message: line, level: null };
  }
}

// Loki instant count: returns scalar sum of matches over the window.
// Uses `count_over_time` which is orders of magnitude faster than fetching
// all lines and counting in JS (1s vs 52s for 1h range on filesystem backend).
async function lokiCount(query: string, endNs: bigint, timeoutMs = 75_000): Promise<number> {
  const url = `${LOKI_URL}/loki/api/v1/query?query=${encodeURIComponent(query)}&time=${endNs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`loki count ${res.status}`);
  const json = await res.json() as { data?: { result?: Array<{ value?: [unknown, string] }> } };
  const v = json.data?.result?.[0]?.value?.[1];
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

// Loki instant count, sliced by service_name. Returns `{svc -> count}`.
async function lokiCountBySvc(query: string, endNs: bigint, timeoutMs = 75_000): Promise<Record<string, number>> {
  const url = `${LOKI_URL}/loki/api/v1/query?query=${encodeURIComponent(query)}&time=${endNs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`loki countBySvc ${res.status}`);
  const json = await res.json() as {
    data?: { result?: Array<{ metric?: Record<string, string>; value?: [unknown, string] }> }
  };
  const out: Record<string, number> = {};
  for (const r of json.data?.result ?? []) {
    const svc = r.metric?.service_name ?? 'unknown';
    const n = Number(r.value?.[1] ?? 0);
    if (Number.isFinite(n)) out[svc] = n;
  }
  return out;
}

// Sample a small batch of recent WARN+ lines for examples + unmatched detection.
async function fetchSample(startNs: bigint, endNs: bigint, limit = 200): Promise<
  Array<{ ts: number; service: string; message: string; level: string | null }>
> {
  const svcSel = `service_name=~"${SERVICES.join('|')}"`;
  const bsq = '\\\\\\\\' + '\\"';
  const jsonFilter = `${bsq}level${bsq}:${bsq}(WARN|ERROR|FATAL)${bsq}`;
  const plainFilter = `LOG_(WARN|WARNING|ERROR|FATAL|CRITICAL)`;
  const q = `{${svcSel}} |~ "${jsonFilter}|${plainFilter}"`;
  const url = `${LOKI_URL}/loki/api/v1/query_range` +
    `?query=${encodeURIComponent(q)}&start=${startNs}&end=${endNs}` +
    `&limit=${limit}&direction=backward`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const json = await res.json() as {
    data?: { result?: Array<{ stream?: Record<string, string>; values?: Array<[string, string]> }> };
  };
  const out: Array<{ ts: number; service: string; message: string; level: string | null }> = [];
  for (const stream of json.data?.result ?? []) {
    const svc = stream.stream?.service_name ?? 'unknown';
    for (const [tsNs, line] of stream.values ?? []) {
      const p = parseLine(line);
      out.push({ ts: Math.round(Number(tsNs) / 1e6), service: svc, message: p.message, level: p.level });
    }
  }
  return out;
}

interface GroupBucket {
  patternId: string | null;
  label: string;
  count: number;
  action: LogAction;
  note: string;
  service: string | null;
  example: string | null;
  lastSeen: number | null;
  services: Record<string, number>;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') ?? '1h';
  const startMsParam = searchParams.get('start') ? Number(searchParams.get('start')) : null;
  const endMsParam   = searchParams.get('end')   ? Number(searchParams.get('end'))   : null;
  const useCustom = startMsParam != null && endMsParam != null && isFinite(startMsParam) && isFinite(endMsParam);

  const windowSec = RANGE_SECONDS[range];
  if (!windowSec && !useCustom) {
    return NextResponse.json({ error: 'unknown range' }, { status: 400 });
  }

  const cacheKey = useCustom ? `custom|${startMsParam}|${endMsParam}` : `range|${range}`;
  const ttlMs = useCustom
    ? 60_000
    : (windowSec! <= 900 ? 30_000
      : windowSec! <= 3600 ? 60_000
      : 180_000);
  const cached = cacheGet(cacheKey);
  if (cached) return NextResponse.json(cached);

  const MS_TO_NS = BigInt(1_000_000);
  const S_TO_NS  = BigInt(1_000_000_000);
  const endNs = useCustom
    ? BigInt(endMsParam!) * MS_TO_NS
    : BigInt(Date.now()) * MS_TO_NS;
  // Loki filesystem-backend regex scans over 6h+ exceed Node's built-in
  // socket timeout (60s). Cap the aggregation window at 1h and advertise
  // the clamped window in the response so the UI can show a notice.
  const MAX_SCAN_SEC = 3600;
  const requestedSec = useCustom
    ? Math.max(1, Math.round((endMsParam! - startMsParam!) / 1000))
    : windowSec!;
  const effectiveSec = Math.min(requestedSec, MAX_SCAN_SEC);
  const wasClamped = effectiveSec < requestedSec;
  const startNs = endNs - BigInt(effectiveSec) * S_TO_NS;
  const rangeSpec = `${effectiveSec}s`;

  try {
    // One parallel count_over_time per known pattern + one for the total.
    const svcTotalSel = `service_name=~"${SERVICES.join('|')}"`;
    const bsq = '\\\\\\\\' + '\\"';
    const totalLineFilter = `|~ "${bsq}level${bsq}:${bsq}(WARN|ERROR|FATAL)${bsq}|LOG_(WARN|WARNING|ERROR|FATAL|CRITICAL)"`;
    const totalQuery = `sum(count_over_time({${svcTotalSel}} ${totalLineFilter} [${rangeSpec}]))`;

    // Pre-filter each pattern query to WARN/ERROR/FATAL — matches the
    // "log-derived events" semantic (complementing Prometheus counters).
    // Patterns that fire at DEBUG (e.g. local_timeout) naturally yield 0 and
    // drop out of the output, since their data lives in NODE EVENTS counters.
    const levelPrefilter = `|~ "${bsq}level${bsq}:${bsq}(WARN|ERROR|FATAL)${bsq}|LOG_(WARN|WARNING|ERROR|FATAL|CRITICAL)"`;
    const patternQueries = LOG_PATTERNS.map(p => {
      const svcSel = p.service
        ? `service_name="${p.service}"`
        : svcTotalSel;
      const esc = p.regex.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const q = `sum by (service_name) (count_over_time({${svcSel}} ${levelPrefilter} |~ "${esc}" [${rangeSpec}]))`;
      return { p, q };
    });

    const [totalCount, ...patternResults] = await Promise.all([
      lokiCount(totalQuery, endNs),
      ...patternQueries.map(({ q }) => lokiCountBySvc(q, endNs)),
    ]);

    // Build buckets from pattern counts (instant numbers — fast, accurate)
    const buckets = new Map<string, GroupBucket>();
    let matchedSum = 0;
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      const p = LOG_PATTERNS[i];
      const bySvc = patternResults[i];
      const count = Object.values(bySvc).reduce((s, n) => s + n, 0);
      matchedSum += count;
      buckets.set(p.id, {
        patternId: p.id, label: p.label, count,
        action: p.action, note: p.note,
        service: p.service ?? null, example: null, lastSeen: null,
        services: bySvc,
      });
    }

    const unmatched = Math.max(0, totalCount - matchedSum);
    buckets.set('__other', {
      patternId: null, label: 'Other / Unrecognized',
      count: unmatched, action: 'investigate',
      note: 'WARN/ERROR lines that did not match any known pattern. Review in NODE LOGS and consider adding to the catalogue.',
      service: null, example: null, lastSeen: null, services: {},
    });

    // Pull a small sample of recent lines for examples + to sanity-check unmatched.
    // This is a bounded query — up to 200 most recent WARN+ lines.
    try {
      const sample = await fetchSample(startNs, endNs, 200);
      for (const s of sample) {
        if (!s.level || !['WARN', 'ERROR', 'FATAL'].includes(s.level)) continue;
        const m = matchLogLine(s.message, s.service);
        const key = m.patternId ?? '__other';
        const b = buckets.get(key);
        if (!b) continue;
        if (!b.lastSeen || s.ts > b.lastSeen) {
          b.lastSeen = s.ts;
          b.example  = s.message.slice(0, 200);
        }
      }
    } catch { /* samples are optional — don't fail the count */ }

    const groups = Array.from(buckets.values())
      .filter(b => b.count > 0)
      .sort((a, b) => b.count - a.count);

    const body: {
      range: string; total: number; unmatched: number;
      groups: GroupBucket[];
      scannedSec: number;
      clamped?: { requestedSec: number; note: string };
    } = {
      range: useCustom ? 'custom' : range,
      total: totalCount,
      unmatched,
      groups,
      scannedSec: effectiveSec,
    };
    if (wasClamped) {
      body.clamped = {
        requestedSec,
        note: `Log-events aggregation capped at ${Math.round(MAX_SCAN_SEC / 60)}m due to Loki scan cost. Counts below cover only the most recent ${Math.round(MAX_SCAN_SEC / 60)}m — use NODE LOGS for ad-hoc search over the full ${range} window.`,
      };
    }
    cacheSet(cacheKey, body, ttlMs);
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
