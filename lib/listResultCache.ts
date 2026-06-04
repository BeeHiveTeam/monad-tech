// Shared cache of the /api/validators (LIST) computed result so that
// /api/validators/[address] (DETAIL) can reuse the EXACT window-derived fields
// the list page shows. These fields (blocksProduced, participationPct, sharePct,
// ageSeconds) are derived from a 500-block sample that each endpoint may
// (re)fetch at different times, so recomputing them independently lets list and
// detail disagree (e.g. participationPct 157.5 vs 70). Sourcing detail from the
// list's already-computed result makes both pages show identical numbers; detail
// falls back to its own computation only when this cache is cold.

export interface ListValidatorSnapshot {
  address: string;
  blocksProduced?: number;
  participationPct?: number;
  sharePct?: number;
  ageSeconds?: number;
}

interface Entry {
  ts: number;
  byAddr: Map<string, ListValidatorSnapshot>;
}

const store = new Map<string, Entry>();

export function setListResult(network: string, data: unknown): void {
  const validators = (data as { validators?: ListValidatorSnapshot[] } | null)?.validators;
  if (!Array.isArray(validators)) return;
  const byAddr = new Map<string, ListValidatorSnapshot>();
  for (const v of validators) {
    if (v && typeof v.address === 'string') byAddr.set(v.address.toLowerCase(), v);
  }
  store.set(network, { ts: Date.now(), byAddr });
}

export function getListValidator(
  network: string,
  addr: string,
  maxAgeMs = 30 * 60_000,
): ListValidatorSnapshot | null {
  const e = store.get(network);
  if (!e || Date.now() - e.ts > maxAgeMs) return null;
  return e.byAddr.get(addr.toLowerCase()) ?? null;
}
