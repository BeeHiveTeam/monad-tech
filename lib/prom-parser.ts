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

export function findOne(
  samples: PromSample[],
  name: string,
  filter?: (labels: Record<string, string>) => boolean,
): PromSample | undefined {
  return samples.find(s => s.name === name && (!filter || filter(s.labels)));
}

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
