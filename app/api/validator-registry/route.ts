import { NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/networks';
import { ensureRegistryLoaded, getRegistryEntries } from '@/lib/validator-registry';
export type { RegistryEntry } from '@/lib/validator-monikers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rpcUrl = process.env.MONAD_RPC_URL ?? NETWORKS['testnet'].rpc;
    await ensureRegistryLoaded(rpcUrl);
    const registry = getRegistryEntries();
    return NextResponse.json({ registry, updatedAt: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
