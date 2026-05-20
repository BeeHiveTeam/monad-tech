import { NextRequest, NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/networks';
import { ensureRegistryLoaded, getRegistryEntries, invalidateRegistryTTL } from '@/lib/validator-registry';
import { apiError } from '@/lib/apiError';
export type { RegistryEntry } from '@/lib/validator-monikers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    // Admin-only TTL bust. Useful when GitHub metadata fetch failed at cold-start
    // and placeholder `validator-N` monikers are stuck for up to an hour.
    if (req.nextUrl.searchParams.get('force') === '1') {
      invalidateRegistryTTL();
    }
    const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS['testnet'].rpc;
    await ensureRegistryLoaded(rpcUrl);
    const registry = getRegistryEntries();
    return NextResponse.json({ registry, updatedAt: Date.now() });
  } catch (e) {
    return apiError(e, 500, 'validator-registry');
  }
}
