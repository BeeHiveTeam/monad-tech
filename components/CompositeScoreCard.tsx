'use client';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer,
} from 'recharts';

export interface CompositeScore {
  composite: number;
  axes: {
    reliability: number;
    production: number;
    returns: number;
    decentralization: number;
    opsMaturity: number;
    infoScore: number;
  };
}

const AXIS_META: Array<{ key: keyof CompositeScore['axes']; label: string; tooltip: string }> = [
  { key: 'reliability',     label: 'RELIABILITY',     tooltip: 'Health × uptime × recency. 40/40/20 weighted.' },
  { key: 'production',      label: 'PRODUCTION',      tooltip: 'How close blocks-produced is to stake-weighted expected.' },
  { key: 'returns',         label: 'RETURNS',         tooltip: 'Inverse of commission. 0% → 100, 15% → 50, ≥30% → 0.' },
  { key: 'decentralization',label: 'DECENTRALIZATION',tooltip: 'Penalty for whale concentration. Lower stake-share = higher score.' },
  { key: 'opsMaturity',     label: 'OPS MATURITY',    tooltip: 'Registered + active set + secp key + history + sane commission.' },
  { key: 'infoScore',       label: 'INFO',            tooltip: 'Metadata completeness: moniker, website, description, logo, social.' },
];

function axisColor(v: number): string {
  if (v >= 75) return '#4CAF6E';
  if (v >= 45) return '#C9A84C';
  return '#E05252';
}

function compositeColor(v: number): string {
  return axisColor(v);
}

export default function CompositeScoreCard({ score }: { score: CompositeScore }) {
  const chartData = AXIS_META.map(a => ({
    axis: a.label,
    value: score.axes[a.key],
    fullMark: 100,
  }));

  return (
    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.06em' }}>
            Composite Score
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxWidth: 540 }}>
            6-axis validator quality score. Weighted mean: Reliability 20% · Production 20% · Returns 15% · Decentralization 15% · Ops Maturity 15% · Info 15%.
          </div>
        </div>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 110, padding: '10px 18px',
          border: `2px solid ${compositeColor(score.composite)}`,
          background: `${compositeColor(score.composite)}15`,
          borderRadius: 8,
        }}>
          <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 38, color: compositeColor(score.composite), lineHeight: 1 }}>
            {score.composite}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginTop: 2 }}>
            COMPOSITE
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'center' }} className="composite-grid">
        {/* Radar */}
        <div style={{ height: 280, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={chartData} margin={{ top: 18, right: 30, bottom: 18, left: 30 }}>
              <PolarGrid stroke="rgba(201,168,76,0.18)" />
              <PolarAngleAxis
                dataKey="axis"
                tick={{ fill: '#8A8870', fontSize: 10, letterSpacing: '0.05em' }}
              />
              <PolarRadiusAxis
                angle={90}
                domain={[0, 100]}
                tick={false}
                axisLine={false}
              />
              <Radar
                dataKey="value"
                stroke="#C9A84C"
                fill="#C9A84C"
                fillOpacity={0.25}
                strokeWidth={2}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Axis breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {AXIS_META.map(a => {
            const v = score.axes[a.key];
            const c = axisColor(v);
            return (
              <div key={a.key} title={a.tooltip} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 130, fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
                  {a.label}
                </div>
                <div style={{ flex: 1, height: 6, background: 'rgba(201,168,76,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${v}%`, height: '100%', background: c }} />
                </div>
                <div style={{ width: 32, textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: c }}>
                  {v}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 720px) {
          :global(.composite-grid) {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
