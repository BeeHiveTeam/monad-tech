interface Props {
  state: 'normal' | 'congested' | 'offline';
  reason: string;
}

const COLORS = {
  normal: { bg: 'rgba(76,175,110,0.1)', border: 'rgba(76,175,110,0.3)', fg: '#4CAF6E', dot: '#4CAF6E' },
  congested: { bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.3)', fg: '#C9A84C', dot: '#C9A84C' },
  offline: { bg: 'rgba(224,82,82,0.1)', border: 'rgba(224,82,82,0.3)', fg: '#E05252', dot: '#E05252' },
};

const LABELS = {
  normal: 'ONLINE — NORMAL',
  congested: 'CONGESTED',
  offline: 'OFFLINE / STOPPED',
};

export default function HealthBadge({ state, reason }: Props) {
  const c = COLORS[state];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '16px 24px',
      background: c.bg,
      border: `1px solid ${c.border}`,
      borderRadius: 12,
    }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%',
        background: c.dot,
        boxShadow: `0 0 14px ${c.dot}`,
        animation: state === 'normal' ? 'pulse 2s infinite' : 'none',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: 'Bebas Neue, sans-serif',
          fontSize: 18, letterSpacing: '0.1em',
          color: c.fg,
          lineHeight: 1,
        }}>
          {LABELS[state]}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          {reason}
        </div>
      </div>
    </div>
  );
}
