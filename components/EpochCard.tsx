interface Props {
  current: number;
  blockInEpoch: number;
  blocksPerEpoch: number;
  blocksUntilNext: number;
  secondsUntilNext: number;
  progressPct: number;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function EpochCard({ current, blockInEpoch, blocksPerEpoch, blocksUntilNext, secondsUntilNext, progressPct }: Props) {
  return (
    <div className="card" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <div style={{
            fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--text-muted)', marginBottom: 6,
          }}>
            Current Epoch
          </div>
          <div style={{
            fontFamily: 'Bebas Neue, sans-serif',
            fontSize: 32, letterSpacing: '0.06em',
            color: 'var(--gold)', lineHeight: 1,
          }}>
            #{current.toLocaleString('en-US')}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--text-muted)', marginBottom: 6,
          }}>
            Next Epoch In
          </div>
          <div style={{
            fontFamily: 'Bebas Neue, sans-serif',
            fontSize: 24, letterSpacing: '0.06em',
            color: 'var(--text)', lineHeight: 1,
          }}>
            {fmtDuration(secondsUntilNext)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'DM Mono, monospace' }}>
            {blocksUntilNext.toLocaleString('en-US')} blocks
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        width: '100%', height: 6,
        background: 'rgba(201,168,76,0.08)',
        borderRadius: 3, overflow: 'hidden', marginBottom: 6,
      }}>
        <div style={{
          width: `${progressPct}%`, height: '100%',
          background: 'linear-gradient(90deg, var(--gold-dim), var(--gold))',
          borderRadius: 3,
          transition: 'width 0.5s ease',
        }} />
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace',
      }}>
        <span>{blockInEpoch.toLocaleString('en-US')} / {blocksPerEpoch.toLocaleString('en-US')}</span>
        <span>{progressPct.toFixed(1)}%</span>
      </div>
    </div>
  );
}
