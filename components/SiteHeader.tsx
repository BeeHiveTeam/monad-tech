'use client';
import Link from 'next/link';
import NetworkSwitch from './NetworkSwitch';
import { NetworkId } from '@/lib/networks';

interface Props {
  network: NetworkId;
  onNetworkChange: (n: NetworkId) => void;
  liveState?: 'live' | 'loading' | 'offline';
  lastUpdate?: Date | null;
}

export default function SiteHeader({ network, onNetworkChange, liveState = 'live', lastUpdate }: Props) {
  const dotColor =
    liveState === 'live' ? 'var(--green)' :
    liveState === 'offline' ? 'var(--red)' :
    'var(--gold-dim)';

  const label =
    liveState === 'live' ? 'LIVE' :
    liveState === 'offline' ? 'OFFLINE' :
    'CONNECTING…';

  return (
    <nav className="site-header" style={{
      position: 'sticky', top: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'rgba(8,8,8,0.9)',
      backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--border)',
      flexWrap: 'wrap', gap: 12,
    }}>
      <Link href="/" className="site-logo" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 14 }}>
        <svg className="site-logo-svg" width="36" height="36" viewBox="0 0 100 100">
          <rect width="100" height="100" fill="#090907" />
          <polygon points="50,8 88,30 88,70 50,92 12,70 12,30" fill="none" stroke="#C9A84C" strokeWidth="6" />
          <text x="50" y="68" textAnchor="middle" fontFamily="Arial Black,sans-serif" fontSize="38" fontWeight="900" fill="#C9A84C">M</text>
        </svg>
        <div>
          <div className="site-logo-title" style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: '0.12em', color: 'var(--gold)' }}>
            MONAD TECH
          </div>
          <div className="site-logo-sub" style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginTop: -2 }}>
            NETWORK MONITOR
          </div>
        </div>
      </Link>

      <NetworkSwitch current={network} onChange={onNetworkChange} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: dotColor,
          animation: liveState === 'live' ? 'pulse 2s infinite' : 'none',
          display: 'inline-block',
        }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
          {label}
        </span>
        {lastUpdate && (
          <span className="live-time" style={{ fontSize: 10, color: 'rgba(138,136,112,0.5)', marginLeft: 6 }}>
            {lastUpdate.toLocaleTimeString()}
          </span>
        )}
      </div>
    </nav>
  );
}
