import { NextResponse } from 'next/server';
import { getStreamState } from '@/lib/wsBlockStream';

export const dynamic = 'force-dynamic';

// Read-only diagnostics for the WebSocket block stream. Reports connection
// state, ring buffer fill, push/enrichment counters. Used during the polling
// → push migration to verify the consumer is healthy before refactoring
// /api/blocks etc. to read from the ring.
export async function GET() {
  return NextResponse.json(getStreamState(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
