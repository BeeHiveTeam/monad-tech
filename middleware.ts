import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Rate limiting — sliding window, in-memory (single PM2 fork process)
// ---------------------------------------------------------------------------
// The home page polls /api/stats, /api/blocks, /api/transactions every 4s plus
// /api/tps-timeline every 2s, /api/exec-stats/15s, /api/network-health, etc.
// A single honest viewer generates ~80 req/min. Cap at 300/min so 3+ tabs or
// multiple users behind the same NAT can coexist, while still blocking
// scrapers that pull >5 req/sec sustained.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;

const ipLog = new Map<string, number[]>();

// Purge stale entries every 5 minutes to prevent unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipLog) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length === 0) ipLog.delete(ip);
    else ipLog.set(ip, fresh);
  }
}, 5 * 60_000);

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (ipLog.get(ip) ?? []).filter(t => t > cutoff);
  hits.push(now);
  ipLog.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Auth — Basic auth for sensitive internal routes
// ---------------------------------------------------------------------------
function requiresAuth(pathname: string): boolean {
  return (
    pathname.startsWith('/node') ||
    pathname.startsWith('/api/node') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/api/analytics/summary')
  );
}

// ---------------------------------------------------------------------------
// Middleware entry point
// ---------------------------------------------------------------------------
export const config = {
  matcher: [
    '/node/:path*',
    '/api/node/:path*',
    '/admin/:path*',
    '/api/analytics/summary/:path*',
    '/api/:path*',
  ],
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rate limit all /api/* routes.
  if (pathname.startsWith('/api/')) {
    const cfIp = req.headers.get('cf-connecting-ip');
    const xff = req.headers.get('x-forwarded-for');
    const xfIp = xff?.split(',')[0].trim();
    const ip = cfIp ?? xfIp ?? 'unknown';

    // Exempt internal loopback callers (background pollers, server-to-server calls between API
    // routes). Without this, /api/network-health calling /api/validators from 127.0.0.1, plus
    // all the background writers, share ONE counter and blow past 300 req/min.
    //
    // The previous test derived "internal" from CLIENT-SUPPLIED headers: ip === '127.0.0.1'
    // (from X-Forwarded-For, which anyone can send) and ip === 'unknown' (no forwarding header
    // at all). Since the documented nginx config sets no proxy headers, a request straight to
    // the origin arrived with neither — so it was classified internal and skipped the limiter
    // entirely. No spoofing even required. Combined with the fan-out on /api/my-delegations,
    // that is a large unauthenticated amplifier.
    //
    // Now: an explicit shared secret if configured, otherwise genuine loopback only — Host is
    // a loopback address AND no forwarding header is present. 'unknown' is no longer exempt.
    const internalToken = process.env.INTERNAL_API_TOKEN;
    const host = req.headers.get('host') ?? '';
    const hostIsLoopback = host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
    // OR, not a replacement. As a ternary, setting INTERNAL_API_TOKEN REPLACED the loopback
    // exemption with a header check — and nothing in this codebase sends that header, so the
    // moment an operator followed the README and set the variable, the instrumentation pollers
    // and the /api/validators fan-out lost their exemption and started collecting 429s. The
    // token is meant to ADD a way to be recognised as internal, not remove the existing one.
    const isInternal =
      (!!internalToken && req.headers.get('x-internal-token') === internalToken)
      || (!cfIp && !xff && hostIsLoopback);

    if (!isInternal && isRateLimited(ip)) {
      return new NextResponse('Too Many Requests', {
        status: 429,
        headers: {
          'Retry-After': '60',
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  // Basic auth for internal routes.
  if (requiresAuth(pathname)) {
    const user = process.env.NODE_AUTH_USER;
    const pass = process.env.NODE_AUTH_PASSWORD;

    // If auth isn't configured, leave routes open (dev/staging).
    if (!user || !pass) return NextResponse.next();

    const expected = `Basic ${btoa(`${user}:${pass}`)}`;
    const got = req.headers.get('authorization');

    if (got !== expected) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="BeeHive Node Monitor", charset="UTF-8"',
        },
      });
    }
  }

  return NextResponse.next();
}
