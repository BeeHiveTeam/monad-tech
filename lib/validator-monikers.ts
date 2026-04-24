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

let _registry: Map<string, ValidatorInfo> | null = null;
let _registryUpdatedAt = 0;

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

export function loadRegistry(entries: RegistryEntry[]): void {
  _registry = new Map();
  for (const e of entries) {
    _registry.set(e.authAddress.toLowerCase(), {
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
  _registryUpdatedAt = Date.now();
}

export function getValidatorInfo(address: string): ValidatorInfo | null {
  const key = address.toLowerCase();
  return _registry?.get(key) ?? STATIC_INFO[key] ?? null;
}

export function getMoniker(address: string): string | null {
  return getValidatorInfo(address)?.moniker ?? null;
}

export function registrySize(): number {
  return _registry?.size ?? 0;
}

export function registryAge(): number {
  return _registryUpdatedAt;
}

export function getRegistrySnapshot(): { authAddress: string; name: string; id: number; secp: string; website?: string; description?: string; logo?: string; x?: string; stakeMon?: number; commissionPct?: number }[] {
  if (!_registry) return [];
  return Array.from(_registry.entries()).map(([addr, info]) => ({
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
