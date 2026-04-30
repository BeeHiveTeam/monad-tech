import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import os from 'os';
import { INFLUX_URL, INFLUX_DB } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Privacy: we hash the IP with a daily-rotating salt so the same visitor
// deduplicates within a day but cannot be correlated across days.
//
// Salt resolution order:
//   1. ANALYTICS_SALT env var (preferred — set explicitly per deployment)
//   2. SHA-256(hostname) derived stably from the OS install
// We deliberately don't fall through to NODE_AUTH_PASSWORD anymore — that
// coupling was an oversight and would expose the auth password's hash domain
// to anyone with sufficient analytics output to bruteforce.
const SALT_BASE = process.env.ANALYTICS_SALT
  || crypto.createHash('sha256').update(`monad-stats-analytics:${os.hostname()}`).digest('hex');

function todayStr(): string {
  // UTC day key, rotates at midnight
  return new Date().toISOString().slice(0, 10);
}

function anonId(ip: string, ua: string): string {
  const h = crypto.createHash('sha256');
  h.update(SALT_BASE);
  h.update('|');
  h.update(todayStr());
  h.update('|');
  h.update(ip);
  h.update('|');
  h.update(ua);
  return h.digest('hex').slice(0, 16);
}

function parseBrowser(ua: string): string {
  if (!ua) return 'unknown';
  if (/\bEdg\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\//.test(ua)) return 'Opera';
  if (/\bFirefox\//.test(ua)) return 'Firefox';
  if (/\bChrome\//.test(ua) && !/\bChromium\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && !/\bChrome\//.test(ua)) return 'Safari';
  if (/\bbot\b|spider|crawler|slurp/i.test(ua)) return 'Bot';
  return 'Other';
}

function parseDevice(ua: string): string {
  if (!ua) return 'unknown';
  if (/\bMobile\b|\bAndroid\b/i.test(ua) && !/\bTablet\b|\biPad\b/i.test(ua)) return 'mobile';
  if (/\biPad\b|\bTablet\b/i.test(ua)) return 'tablet';
  return 'desktop';
}

function parseOs(ua: string): string {
  if (!ua) return 'unknown';
  if (/\bWindows NT\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b/.test(ua)) return 'macOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\biPhone OS\b|\biPad\b/.test(ua)) return 'iOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return 'Other';
}

function normalizePath(p: string): string {
  // Collapse dynamic segments so /block/27164313 aggregates as /block/:n
  return p
    .replace(/^\/block\/[^/?#]+/, '/block/:n')
    .replace(/^\/tx\/[^/?#]+/, '/tx/:hash')
    .replace(/^\/validators\/[^/?#]+/, '/validators/:addr');
}

function normalizeReferrer(r: string | null): string {
  if (!r) return 'direct';
  try {
    const u = new URL(r);
    // Both the old subdomain (monad-tech.bee-hive.work + bee-hive.work) and the
    // new root domain (monad-tech.com) should count as internal, not external.
    if (u.hostname.endsWith('bee-hive.work')) return 'internal';
    if (u.hostname === 'monad-tech.com' || u.hostname.endsWith('.monad-tech.com')) return 'internal';
    return u.hostname;
  } catch {
    return 'unknown';
  }
}

function influxEscapeTag(s: string): string {
  // InfluxDB line protocol: escape commas, equal signs, spaces
  return s.replace(/([,=\s])/g, '\\$1');
}

async function influxWrite(line: string): Promise<void> {
  try {
    await fetch(`${INFLUX_URL}/write?db=${INFLUX_DB}&precision=ms`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: line,
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* fire-and-forget */ }
}

interface TrackBody {
  path?: string;
  referrer?: string | null;
  title?: string;
  screen?: string;      // e.g. "1920x1080"
}

export async function POST(req: NextRequest) {
  let body: TrackBody;
  try {
    body = await req.json() as TrackBody;
  } catch {
    return NextResponse.json({ error: 'bad body' }, { status: 400 });
  }

  // Sanitize inputs
  const rawPath = (body.path || '/').slice(0, 200);
  const path = normalizePath(rawPath);
  const referrer = normalizeReferrer(body.referrer ?? null).slice(0, 80);

  const ua = (req.headers.get('user-agent') || '').slice(0, 300);
  const browser = parseBrowser(ua);
  const device  = parseDevice(ua);
  const os      = parseOs(ua);
  // Bots don't count
  if (browser === 'Bot') return NextResponse.json({ ok: true, skipped: 'bot' });

  // IP: prefer CF-Connecting-IP, then X-Forwarded-For, then direct.
  const ip = (req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || '0.0.0.0').slice(0, 64);

  // CF-IPCountry is set by Cloudflare if the site is proxied through it.
  const country = (req.headers.get('cf-ipcountry') || 'XX').slice(0, 4).toUpperCase();

  const visitor = anonId(ip, ua);

  // InfluxDB line protocol: measurement,tag1=v1,tag2=v2 field=value timestamp
  const line =
    `monad_analytics,` +
    `path=${influxEscapeTag(path)},` +
    `referrer=${influxEscapeTag(referrer)},` +
    `country=${influxEscapeTag(country)},` +
    `browser=${influxEscapeTag(browser)},` +
    `os=${influxEscapeTag(os)},` +
    `device=${influxEscapeTag(device)} ` +
    `visits=1i,visitor="${visitor}" ${Date.now()}`;

  // fire-and-forget so we never block the user's page load
  influxWrite(line);

  return NextResponse.json({ ok: true });
}
