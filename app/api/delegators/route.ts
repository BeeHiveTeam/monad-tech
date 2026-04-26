import { NextRequest, NextResponse } from 'next/server';
import { getDelegatorsByTarget, getRecentOps } from '@/lib/stakingOps';

export const dynamic = 'force-dynamic';

const RANGE_SECONDS: Record<string, number> = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
};

// Accepts either `target` (the 20-byte staking identifier from tx input
// payload) or `address` (validator's authAddress — but on Monad testnet these
// don't match the payload directly, so usually `target` is the right query).
//
// If neither is given, returns recent staking activity across all validators
// — useful for a network-wide "delegation stream" view.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const target = sp.get('target') ?? sp.get('address') ?? null;
  const rangeKey = sp.get('range') ?? '24h';
  const windowSeconds = RANGE_SECONDS[rangeKey];
  if (!windowSeconds) {
    return NextResponse.json(
      { error: `Invalid range. Use one of ${Object.keys(RANGE_SECONDS).join(', ')}` },
      { status: 400 },
    );
  }

  try {
    if (target) {
      // Per-target aggregation.
      const delegators = await getDelegatorsByTarget(target.toLowerCase(), windowSeconds);
      const recent = await getRecentOps(windowSeconds, 50, target.toLowerCase());
      return NextResponse.json({
        target: target.toLowerCase(),
        range: rangeKey,
        delegatorCount: delegators.length,
        totalMon: delegators.reduce((a, d) => a + d.totalMon, 0),
        opCount: delegators.reduce((a, d) => a + d.opCount, 0),
        delegators,
        recentOps: recent,
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }

    // Network-wide recent activity.
    const recent = await getRecentOps(windowSeconds, 100);
    // Compute top targets + top delegators from the sample.
    const byTarget = new Map<string, { mon: number; count: number }>();
    const byDelegator = new Map<string, { mon: number; count: number }>();
    for (const op of recent) {
      const t = byTarget.get(op.target) ?? { mon: 0, count: 0 };
      t.mon += op.amountMon; t.count++;
      byTarget.set(op.target, t);

      const d = byDelegator.get(op.delegator) ?? { mon: 0, count: 0 };
      d.mon += op.amountMon; d.count++;
      byDelegator.set(op.delegator, d);
    }
    const topTargets = Array.from(byTarget.entries())
      .map(([target, v]) => ({ target, ...v }))
      .sort((a, b) => b.mon - a.mon).slice(0, 10);
    const topDelegators = Array.from(byDelegator.entries())
      .map(([delegator, v]) => ({ delegator, ...v }))
      .sort((a, b) => b.mon - a.mon).slice(0, 10);

    return NextResponse.json({
      range: rangeKey,
      opCount: recent.length,
      totalMon: recent.reduce((a, op) => a + op.amountMon, 0),
      topTargets,
      topDelegators,
      recentOps: recent.slice(0, 50),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
