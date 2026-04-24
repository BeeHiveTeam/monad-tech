import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
const INFLUX_DB = process.env.INFLUX_DB || 'monad';

const RANGES: Record<string, string> = {
  '24h': '24h',
  '7d':  '7d',
  '30d': '30d',
};

async function query(q: string): Promise<unknown[][]> {
  const res = await fetch(
    `${INFLUX_URL}/query?db=${INFLUX_DB}&epoch=ms&q=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return [];
  const j = await res.json() as {
    results?: Array<{ series?: Array<{ values?: unknown[][] }> }>;
  };
  return j.results?.[0]?.series?.[0]?.values ?? [];
}

async function queryAll(q: string): Promise<Array<{ tags?: Record<string, string>; values?: unknown[][] }>> {
  const res = await fetch(
    `${INFLUX_URL}/query?db=${INFLUX_DB}&epoch=ms&q=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return [];
  const j = await res.json() as {
    results?: Array<{ series?: Array<{ tags?: Record<string, string>; values?: unknown[][] }> }>;
  };
  return j.results?.[0]?.series ?? [];
}

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') || '24h';
  const dur = RANGES[range];
  if (!dur) return NextResponse.json({ error: 'range must be 24h/7d/30d' }, { status: 400 });

  const timeFilter = `time > now()-${dur}`;

  // Total visits / unique visitors (by distinct visitor hash field)
  const totalRows     = await query(`SELECT SUM(visits) FROM monad_analytics WHERE ${timeFilter}`);
  const uniqueRows    = await query(`SELECT COUNT(DISTINCT visitor) FROM monad_analytics WHERE ${timeFilter}`);

  // Visits grouped by time — for the line chart. 1h buckets for 24h, 6h for 7d, 1d for 30d.
  const bucket = range === '24h' ? '1h' : range === '7d' ? '6h' : '1d';
  const seriesRows = await query(
    `SELECT SUM(visits) FROM monad_analytics WHERE ${timeFilter} GROUP BY time(${bucket}) fill(0)`
  );

  // Top-N rollups via GROUP BY tag
  const byTag = async (tag: string, limit: number) => {
    const series = await queryAll(
      `SELECT SUM(visits) FROM monad_analytics WHERE ${timeFilter} GROUP BY ${tag}`
    );
    const items = series.map(s => ({
      key: s.tags?.[tag] ?? 'unknown',
      visits: Number((s.values?.[0]?.[1] ?? 0) as number),
    }));
    items.sort((a, b) => b.visits - a.visits);
    return items.slice(0, limit);
  };

  const [topPaths, topReferrers, topCountries, topBrowsers, topOs, topDevices] = await Promise.all([
    byTag('path', 20),
    byTag('referrer', 15),
    byTag('country', 15),
    byTag('browser', 10),
    byTag('os', 10),
    byTag('device', 5),
  ]);

  const totalVisits = Number((totalRows[0]?.[1] as number) ?? 0);
  const uniqueVisitors = Number((uniqueRows[0]?.[1] as number) ?? 0);

  return NextResponse.json({
    range,
    totalVisits,
    uniqueVisitors,
    timeseries: seriesRows.map(r => ({ ts: Number(r[0]), visits: Number(r[1] ?? 0) })),
    topPaths,
    topReferrers,
    topCountries,
    topBrowsers,
    topOs,
    topDevices,
  });
}
