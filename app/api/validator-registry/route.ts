import { NextRequest, NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/networks';
import { ensureRegistryLoaded, getRegistryEntries, getRegistryStatus } from '@/lib/validator-registry';
import { apiError } from '@/lib/apiError';
import { registryAge } from '@/lib/validator-monikers';
export type { RegistryEntry } from '@/lib/validator-monikers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    // Public reads must not invalidate shared cache/backoff or start a forced scan.
    if (req.nextUrl.searchParams.has('force')) {
      return NextResponse.json({ error: 'Forced registry refresh is not available.' }, {
        status: 403, headers: { 'Cache-Control': 'no-store' },
      });
    }
    const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS['testnet'].rpc;
    await ensureRegistryLoaded(rpcUrl);
    const registry = getRegistryEntries();
    return NextResponse.json({ registry, updatedAt: registryAge(), ...getRegistryStatus() });
  } catch (e) {
    return apiError(e, 500, 'validator-registry');
  }
}
