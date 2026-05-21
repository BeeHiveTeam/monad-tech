export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestampMs?: number;
}

const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?[0-9.eE+\-]+|NaN|\+Inf|-Inf)(\s+\d+)?\s*$/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    const labelsStr = m[3] ?? '';
    const value = parseFloat(m[4]);
    if (!isFinite(value)) continue;
    const tsStr = m[5]?.trim();
    const timestampMs = tsStr ? parseInt(tsStr, 10) : undefined;

    const labels: Record<string, string> = {};
    let lm: RegExpExecArray | null;
    LABEL_RE.lastIndex = 0;
    while ((lm = LABEL_RE.exec(labelsStr)) !== null) {
      labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
    }
    out.push({ name, labels, value, timestampMs });
  }
  return out;
}

/**
 * Pick the metric series with the LATEST timestamp.
 *
 * Why this is the default behaviour (not "first match"): after a validator
 * binary upgrade (e.g. service_version 0.14.3 → 0.14.4), the otelcol
 * pipeline often keeps exporting BOTH label variants for a while:
 *
 *   monad_node_info{service_version="0.14.3", ...} 1 1779376487972  ← stale
 *   monad_node_info{service_version="0.14.4", ...} 1 1779378854830  ← live
 *
 * A naive `find-first` returns whichever shows up first in the exposition
 * format (typically the alphabetically-earlier label), which after upgrade
 * is the OLD series. That's exactly what made /beehive read a 39-min-old
 * timestamp and render "NODE STALE" while the new version was actively
 * reporting — bug fixed 2026-05-21.
 *
 * Picking max(timestampMs) is correct for ANY metric: when there's only
 * one series, behaviour is identical to find-first; when there are
 * multiple (label-split, version upgrade, generation change), we always
 * pick the freshest. No caller is harmed by the change.
 *
 * `findLatest` is the canonical name; `findOne` is kept as a backward-
 * compatible alias for existing imports.
 */
export function findLatest(
  samples: PromSample[],
  name: string,
  filter?: (labels: Record<string, string>) => boolean,
): PromSample | undefined {
  let best: PromSample | undefined;
  for (const s of samples) {
    if (s.name !== name) continue;
    if (filter && !filter(s.labels)) continue;
    if (!best) { best = s; continue; }
    const a = s.timestampMs ?? 0;
    const b = best.timestampMs ?? 0;
    if (a > b) best = s;
  }
  return best;
}

// Backward-compatible alias — now points to the latest-by-timestamp variant.
export const findOne = findLatest;

export function findAll(
  samples: PromSample[],
  name: string,
  filter?: (labels: Record<string, string>) => boolean,
): PromSample[] {
  return samples.filter(s => s.name === name && (!filter || filter(s.labels)));
}

export function sumBy(
  samples: PromSample[],
  name: string,
  filter?: (labels: Record<string, string>) => boolean,
): number {
  return findAll(samples, name, filter).reduce((a, s) => a + s.value, 0);
}
