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
    const ip =
      req.headers.get('cf-connecting-ip') ??
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      'unknown';

    if (isRateLimited(ip)) {
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
