interface Props {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  accent?: boolean;
}

export default function StatCard({ label, value, sub, icon, accent }: Props) {
  return (
    <div className="card card-hover" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          {label}
        </span>
        {icon && <span style={{ color: 'var(--gold)', opacity: 0.7 }}>{icon}</span>}
      </div>
      <div style={{
        fontSize: 28, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.06em',
        color: accent ? 'var(--gold)' : 'var(--text)',
        lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub}</div>
      )}
    </div>
  );
}
