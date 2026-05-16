import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Centralized error response for API routes.
 *
 * Why: `NextResponse.json({ error: String(err) }, { status: 500 })` leaks
 * internal details to the client — file paths, RPC URLs, InfluxDB query
 * strings, stack hints — that an attacker can use to map our infrastructure.
 *
 * Instead: log the full error server-side (with a request ID) and return a
 * short generic message + that ID to the client. Operators can grep the PM2
 * log by request ID to find the matching stack.
 */
export function apiError(
  err: unknown,
  status: number = 500,
  context: string = 'route',
): NextResponse {
  const requestId = crypto.randomBytes(6).toString('hex');
  // Full error to server log (PM2 captures stderr).
  // eslint-disable-next-line no-console
  console.error(`[apiError ${requestId}] (${context})`, err);
  return NextResponse.json(
    {
      error: 'Internal error',
      requestId,
    },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}
