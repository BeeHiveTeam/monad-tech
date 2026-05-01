import type { NetworkId } from './networks';

export interface ValidatorInfo {
  moniker: string;
  website?: string;
  description?: string;
  logo?: string;
  x?: string;
  validatorId?: number;
  secp?: string;
  stakeMon?: number;
  commissionPct?: number;
}

// Static fallback for known validators
const STATIC_INFO: Record<string, ValidatorInfo> = {
  '0x063882309dff155ad967bcf08db42e0ee799b602': {
    moniker: 'BeeHive',
    website: 'https://bee-hive.work',
    description: 'BeeHive Validator — professional Monad testnet operator',
  },
};

// Per-network registry — testnet and mainnet have separate validator sets,
// and mainnet currently has none on-chain. Keeping them isolated prevents
// one network's data from leaking into the other after a network switch.
const _registries: Map<NetworkId, Map<string, ValidatorInfo>> = new Map();
const _registryUpdatedAt: Map<NetworkId, number> = new Map();

export interface RegistryEntry {
  id: number;
  name: string;
  authAddress: string;
  secp: string;
  website?: string;
  description?: string;
  logo?: string;
  x?: string;
  stakeMon?: number;
  commissionPct?: number;
}

export function loadRegistry(entries: RegistryEntry[], network: NetworkId = 'testnet'): void {
  const reg = new Map<string, ValidatorInfo>();
  for (const e of entries) {
    reg.set(e.authAddress.toLowerCase(), {
      moniker: e.name,
      website: e.website,
      description: e.description,
      logo: e.logo,
      x: e.x,
      validatorId: e.id,
      secp: e.secp,
      stakeMon: e.stakeMon,
      commissionPct: e.commissionPct,
    });
  }
  _registries.set(network, reg);
  _registryUpdatedAt.set(network, Date.now());
}

export function getValidatorInfo(address: string, network: NetworkId = 'testnet'): ValidatorInfo | null {
  const key = address.toLowerCase();
  return _registries.get(network)?.get(key) ?? STATIC_INFO[key] ?? null;
}

export function getMoniker(address: string, network: NetworkId = 'testnet'): string | null {
  return getValidatorInfo(address, network)?.moniker ?? null;
}

export function registrySize(network: NetworkId = 'testnet'): number {
  return _registries.get(network)?.size ?? 0;
}

export function registryAge(network: NetworkId = 'testnet'): number {
  return _registryUpdatedAt.get(network) ?? 0;
}

export function getRegistrySnapshot(network: NetworkId = 'testnet'): { authAddress: string; name: string; id: number; secp: string; website?: string; description?: string; logo?: string; x?: string; stakeMon?: number; commissionPct?: number }[] {
  const reg = _registries.get(network);
  if (!reg) return [];
  return Array.from(reg.entries()).map(([addr, info]) => ({
    authAddress: addr,
    name: info.moniker,
    id: info.validatorId ?? 0,
    secp: info.secp ?? '',
    website: info.website,
    description: info.description,
    logo: info.logo,
    x: info.x,
    stakeMon: info.stakeMon,
    commissionPct: info.commissionPct,
  }));
}
