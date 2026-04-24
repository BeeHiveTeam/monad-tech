'use client';
import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

interface ExecPoint {
  block: number;
  ts: number;
  tx: number;
  rt: number;
  rtp: number;
  sr: number;
  txe: number;
  cmt: number;
  tot: number;
  tpse: number;
  gpse: number;
}

interface ExecSummary {
  count: number;
  rtpAvg: number;
  rtpPeak: number;
  rtpP95: number;
  totAvg: number;
  tpseAvg: number;
  tpsePeak: number;
  gpseAvg: number;
  gpsePeak: number;
  blocksWithRetries: number;
  retriesShare: number;
}

type Range = '5m' | '15m' | '1h' | '6h' | '12h' | '24h' | '7d';

const KPI_CARD: React.CSSProperties = {
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const KPI_LABEL: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const KPI_VALUE: React.CSSProperties = {
  fontFamily: 'Bebas Neue, sans-serif',
  fontSize: 24,
  letterSpacing: '0.04em',
  lineHeight: 1,
};

const KPI_SUB: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
};

// Colour a bar based on retry_pct value — same thresholds as ops.rustemar.dev
function rtpColor(v: number): string {
  if (v >= 75) return '#E05252';
  if (v >= 65) return '#E8A020';
  if (v >= 25) return '#C9A84C';
  return '#4CAF6E';
}

export default function ParallelismPanel({ range }: { range: Range }) {
  const [summary, setSummary] = useState<ExecSummary | null>(null);
  const [points, setPoints] = useState<ExecPoint[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/exec-stats?range=${range}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as { summary: ExecSummary; points: ExecPoint[] };
        if (!cancelled) { setSummary(j.summary); setPoints(j.points); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [range]);

  const s = summary;

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, letterSpacing: '0.08em', color: 'var(--gold)' }}>
            PARALLEL EXECUTION
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
            monad-specific · last {range}
          </span>
        </div>
        {s && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {s.count} blocks sampled
          </span>
        )}
      </div>

      {/* KPI grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>retry_pct avg</span>
          <span style={{ ...KPI_VALUE, color: rtpColor(s?.rtpAvg ?? 0) }}>
            {s ? `${s.rtpAvg.toFixed(2)}%` : '—'}
          </span>
          <span style={KPI_SUB}>
            {s ? `p95: ${s.rtpP95.toFixed(1)}%` : 'tx re-executed'}
          </span>
        </div>

        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>retry_pct peak</span>
          <span style={{ ...KPI_VALUE, color: rtpColor(s?.rtpPeak ?? 0) }}>
            {s ? `${s.rtpPeak.toFixed(2)}%` : '—'}
          </span>
          <span style={KPI_SUB}>worst block in window</span>
        </div>

        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>blocks with retries</span>
          <span style={{ ...KPI_VALUE, color: 'var(--gold)' }}>
            {s ? `${s.retriesShare.toFixed(1)}%` : '—'}
          </span>
          <span style={KPI_SUB}>
            {s ? `${s.blocksWithRetries} / ${s.count}` : '—'}
          </span>
        </div>

        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>effective TPS peak</span>
          <span style={{ ...KPI_VALUE, color: 'var(--gold)' }}>
            {s ? s.tpsePeak.toLocaleString() : '—'}
          </span>
          <span style={KPI_SUB}>fastest moment inside a block</span>
        </div>

        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>gas/sec peak</span>
          <span style={{ ...KPI_VALUE, color: 'var(--gold)' }}>
            {s ? s.gpsePeak.toLocaleString() : '—'}
          </span>
          <span style={KPI_SUB}>per-block peak</span>
        </div>

        <div className="card card-hover" style={KPI_CARD}>
          <span style={KPI_LABEL}>block exec avg</span>
          <span style={{ ...KPI_VALUE, color: 'var(--text)' }}>
            {s ? `${(s.totAvg / 1000).toFixed(2)}ms` : '—'}
          </span>
          <span style={KPI_SUB}>sr + tx_exec + commit</span>
        </div>
      </div>

      {/* Retry % chart */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.06em' }}>
        RETRY % PER BLOCK
      </div>
      <div style={{ height: 160 }}>
        {err ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {err}
          </div>
        ) : points.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Collecting data…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 4, right: 8, left: 4, bottom: 0 }} barCategoryGap={0}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(201,168,76,0.08)" vertical={false} />
              <XAxis
                dataKey="block"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                interval="preserveStartEnd"
                tickFormatter={(v) => String(v).slice(-4)}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v) => `${v}%`}
                width={38}
              />
              <Tooltip
                cursor={{ fill: 'rgba(201,168,76,0.05)' }}
                contentStyle={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 11,
                }}
                labelStyle={{ color: 'var(--gold)' }}
                itemStyle={{ color: 'var(--text)' }}
                formatter={(value, _name, entry) => {
                  const p = entry.payload as ExecPoint;
                  const v = typeof value === 'number' ? value : 0;
                  return [
                    `${v.toFixed(2)}% (${p.rt}/${p.tx} tx re-run)`,
                    'retry_pct',
                  ];
                }}
                labelFormatter={(label) => `block ${label}`}
              />
              <Bar dataKey="rtp" isAnimationActive={false}>
                {points.map((p, i) => (
                  <Cell key={i} fill={rtpColor(p.rtp)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text)' }}>retry_pct</strong> = share of transactions re-executed after a parallel-execution conflict.
        Unique to Monad's OCC engine. Low = independent tx, high = hot contract contention.
        Source: local validator <code>__exec_block</code> logs.
      </div>

      {/* Exec time breakdown */}
      <div style={{
        marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 8, marginBottom: 6,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
            BLOCK EXECUTION TIME BREAKDOWN (µs)
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-muted)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, background: '#5B8FB9', borderRadius: 2, display: 'inline-block' }} />
              state_reset
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, background: '#C9A84C', borderRadius: 2, display: 'inline-block' }} />
              tx_exec
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, background: '#D97D54', borderRadius: 2, display: 'inline-block' }} />
              commit
            </span>
          </div>
        </div>
        <div style={{ height: 180 }}>
          {err ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {err}
            </div>
          ) : points.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              Collecting data…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} margin={{ top: 4, right: 8, left: 4, bottom: 0 }} barCategoryGap={0}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(201,168,76,0.08)" vertical={false} />
                <XAxis
                  dataKey="block"
                  tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                  interval="preserveStartEnd"
                  tickFormatter={(v) => String(v).slice(-4)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                  tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}ms` : `${v}µs`}
                  width={52}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(201,168,76,0.05)' }}
                  contentStyle={{
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  labelStyle={{ color: 'var(--gold)' }}
                  itemStyle={{ color: 'var(--text)' }}
                  formatter={(value, name) => {
                    const v = typeof value === 'number' ? value : 0;
                    return [`${v}µs`, String(name)];
                  }}
                  labelFormatter={(label, items) => {
                    const p = items?.[0]?.payload as ExecPoint | undefined;
                    if (!p) return `block ${label}`;
                    return `block ${label} · total ${p.tot}µs · ${p.tx} tx`;
                  }}
                />
                <Bar dataKey="sr" stackId="exec" fill="#5B8FB9" isAnimationActive={false} name="state_reset" />
                <Bar dataKey="txe" stackId="exec" fill="#C9A84C" isAnimationActive={false} name="tx_exec" />
                <Bar dataKey="cmt" stackId="exec" fill="#D97D54" isAnimationActive={false} name="commit" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          <strong style={{ color: '#5B8FB9' }}>state_reset</strong> = preparing state snapshot ·
          {' '}<strong style={{ color: '#C9A84C' }}>tx_exec</strong> = actual parallel tx execution (+ any retries) ·
          {' '}<strong style={{ color: '#D97D54' }}>commit</strong> = merging results to trie + journald write.
        </div>
      </div>
    </div>
  );
}
