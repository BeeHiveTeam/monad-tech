import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';

const RANGE_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600,
  '6h': 21600, '12h': 43200, '24h': 86400,
};
const ALLOWED_SERVICES = new Set(['monad', 'monad-execution', 'monad-bft', 'monad-rpc']);
const ALLOWED_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
type Level = typeof ALLOWED_LEVELS[number];

const LEVELS_FROM: Record<Level, Level[]> = {
  TRACE: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
  DEBUG: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
  INFO:  ['INFO', 'WARN', 'ERROR', 'FATAL'],
  WARN:  ['WARN', 'ERROR', 'FATAL'],
  ERROR: ['ERROR', 'FATAL'],
  FATAL: ['FATAL'],
};

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Two log formats from journald:
//
// monad-bft: MESSAGE is JSON  → {"timestamp":"...","level":"DEBUG","fields":{"message":"..."}, "target":"..."}
// monad-execution: MESSAGE is plain text → "2026-04-22 16:53:45 [pid] file.cpp:123 LOG_INFO\tactual message"
//
// Returns the clean parsed message + level + a reconstructed journalctl-style
// line (syslog envelope + original MESSAGE), useful for operator drill-down.
function parseJournaldLine(line: string, entryTsNs: string): {
  message: string;
  level: string | null;
  raw: string;
} {
  try {
    const outer = JSON.parse(line) as Record<string, string>;
    const msgStr = outer.MESSAGE;

    // Reconstruct classic journalctl format using Loki entry timestamp:
    //   "Mmm DD HH:MM:SS HOST SYSLOG_ID[PID]: MESSAGE"
    let raw = line;
    if (msgStr) {
      try {
        const ms = Math.round(Number(entryTsNs) / 1e6);
        const d = new Date(ms);
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const stamp = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2,' ')} ` +
          `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
        const host = outer._HOSTNAME ?? '-';
        const ident = outer.SYSLOG_IDENTIFIER ?? outer._COMM ?? outer._SYSTEMD_UNIT ?? 'unknown';
        const pid = outer._PID ? `[${outer._PID}]` : '';
        raw = `${stamp} ${host} ${ident}${pid}: ${msgStr}`;
      } catch { /* fall through to raw=line */ }
    }

    if (!msgStr) return { message: line, level: null, raw };

    // Structured JSON (monad-bft / monad-rpc)
    try {
      const inner = JSON.parse(msgStr) as {
        level?: string;
        fields?: { message?: string; [k: string]: unknown };
        target?: string;
        message?: string;
      };
      const msg = inner.fields?.message ?? inner.message ?? msgStr;
      // Append all extra fields (excluding `message`) as key=value pairs
      const extras = Object.entries(inner.fields ?? {})
        .filter(([k]) => k !== 'message')
        .map(([k, v]) => `${k}=${v}`)
        .join(' · ');
      const target = inner.target ? ` [${inner.target}]` : '';
      const full = extras ? `${msg} · ${extras}${target}` : `${msg}${target}`;
      return { message: full, level: inner.level?.toUpperCase() ?? null, raw };
    } catch {
      // Plain-text (monad-execution): extract LOG_LEVEL and message after the tab
      const levelMatch = msgStr.match(/\bLOG_(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/);
      const level = levelMatch
        ? levelMatch[1].replace('WARNING', 'WARN').replace('CRITICAL', 'FATAL')
        : null;
      const tabIdx = msgStr.indexOf('\t');
      const cleanMsg = tabIdx >= 0 ? msgStr.slice(tabIdx + 1) : msgStr;
      return { message: cleanMsg, level, raw };
    }
  } catch {
    return { message: line, level: null, raw: line };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') ?? '15m';
  const service = searchParams.get('service') ?? '';
  const levelParam = (searchParams.get('level') ?? '').toUpperCase();
  const q = searchParams.get('q') ?? '';
  const limit = Math.max(1, Math.min(1000, parseInt(searchParams.get('limit') ?? '200', 10) || 200));

  const startMs = searchParams.get('start') ? Number(searchParams.get('start')) : null;
  const endMs   = searchParams.get('end')   ? Number(searchParams.get('end'))   : null;
  const useCustomWindow = startMs != null && endMs != null && isFinite(startMs) && isFinite(endMs);

  const windowSec = RANGE_SECONDS[range];
  if (!windowSec && !useCustomWindow) return NextResponse.json({ error: 'unknown range' }, { status: 400 });
  if (service && !ALLOWED_SERVICES.has(service)) {
    return NextResponse.json({ error: 'unknown service' }, { status: 400 });
  }
  if (levelParam && !(ALLOWED_LEVELS as readonly string[]).includes(levelParam)) {
    return NextResponse.json({ error: 'unknown level' }, { status: 400 });
  }

  // Stream selector — service_name only (severity_text label not set by journald receiver)
  const svcSelector = service
    ? `service_name="${escapeLabelValue(service)}"`
    : `service_name=~"${Array.from(ALLOWED_SERVICES).join('|')}"`;
  let logql = `{${svcSelector}}`;

  // Level filter via line-filter regex covering both log formats:
  //   monad-bft:       JSON stored as \"level\":\"WARN\" (literal backslash+quote in stored line)
  //   monad-execution: plain text LOG_WARN
  //
  // The stored line contains actual \ chars before each ", so the LogQL regex must match `\"`.
  // In LogQL string: \\\\\" → decodes to \\\" → regex `\\"` → matches literal `\"` in stored text.
  if (levelParam) {
    const levels = LEVELS_FROM[levelParam as Level];
    const lvl = levels.join('|');
    // bsq = \\\\\" (5 chars: 4 backslashes + escaped-quote) → in LogQL regex matches \"
    const bsq = '\\\\\\\\' + '\\"';
    const jsonFilter = `${bsq}level${bsq}:${bsq}(${lvl})${bsq}`;
    const plainFilter = `LOG_(${lvl})`;
    logql += ` |~ "${jsonFilter}|${plainFilter}"`;
  }

  if (q) {
    const safe = q.slice(0, 200).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    logql += ` |~ "${safe}"`;
  }

  const MS_TO_NS = BigInt(1_000_000);
  const S_TO_NS = BigInt(1_000_000_000);
  const endNs = useCustomWindow
    ? BigInt(endMs!) * MS_TO_NS
    : BigInt(Date.now()) * MS_TO_NS;
  const startNs = useCustomWindow
    ? BigInt(startMs!) * MS_TO_NS
    : endNs - BigInt(windowSec!) * S_TO_NS;

  const lokiUrl =
    `${LOKI_URL}/loki/api/v1/query_range` +
    `?query=${encodeURIComponent(logql)}` +
    `&start=${startNs}&end=${endNs}` +
    `&limit=${limit}&direction=backward`;

  try {
    const res = await fetch(lokiUrl, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return NextResponse.json({ error: `loki ${res.status}`, detail: body.slice(0, 240) }, { status: 502 });
    }
    const json = await res.json() as {
      status: string;
      data?: {
        resultType?: string;
        result?: Array<{
          stream?: Record<string, string>;
          values?: Array<[string, string, Record<string, string>?]>;
        }>;
      };
    };

    interface Entry {
      ts: number; service: string; level: string; message: string;
      raw: string; traceId: string | null;
    }
    const logs: Entry[] = [];
    for (const stream of json.data?.result ?? []) {
      const labels = stream.stream ?? {};
      const svc = labels.service_name || 'unknown';
      const streamLevel = (labels.severity_text || labels.detected_level || 'UNKNOWN').toUpperCase();
      for (const entry of stream.values ?? []) {
        const [tsNs, line, meta] = entry;
        const ts = Math.round(Number(tsNs) / 1e6);
        const parsed = parseJournaldLine(line, tsNs);
        logs.push({
          ts,
          service: svc,
          level: parsed.level ?? streamLevel,
          message: parsed.message,
          raw: parsed.raw,
          traceId: (meta && (meta.trace_id || meta.traceId)) ? (meta.trace_id || meta.traceId) : null,
        });
      }
    }
    logs.sort((a, b) => b.ts - a.ts);

    return NextResponse.json({ logs: logs.slice(0, limit), range, count: Math.min(logs.length, limit) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
