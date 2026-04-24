'use client';
import { NetworkId, NETWORKS } from '@/lib/networks';

interface Props {
  current: NetworkId;
  onChange: (n: NetworkId) => void;
}

export default function NetworkSwitch({ current, onChange }: Props) {
  return (
    <div style={{
      display: 'flex', gap: 4,
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 10, padding: 4,
    }}>
      {(Object.values(NETWORKS) as typeof NETWORKS[NetworkId][]).map((net) => {
        const shortName = net.id === 'testnet' ? 'Testnet' : 'Mainnet';
        return (
          <button
            key={net.id}
            onClick={() => net.active && onChange(net.id)}
            className="net-btn"
            style={{
              padding: '6px 16px',
              borderRadius: 7,
              border: 'none',
              cursor: net.active ? 'pointer' : 'not-allowed',
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: '0.06em',
              transition: 'all 0.2s',
              background: current === net.id ? 'var(--gold)' : 'transparent',
              color: current === net.id ? '#080808' : net.active ? 'var(--text-muted)' : 'rgba(138,136,112,0.35)',
              opacity: net.active ? 1 : 0.5,
            }}
            title={!net.active ? 'Coming soon' : ''}
          >
            <span className="net-label-full">{net.active ? net.name : `${net.name} (soon)`}</span>
            <span className="net-label-short">{net.active ? shortName : `${shortName} (soon)`}</span>
          </button>
        );
      })}
    </div>
  );
}
