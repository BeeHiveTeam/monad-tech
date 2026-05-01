'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Tab {
  label: string;
  href: string;
  disabled?: boolean;
  badge?: string;
}

const TABS: Tab[] = [
  { label: 'Network Status', href: '/' },
  { label: 'Validators', href: '/validators' },
  { label: 'Network Health', href: '/network' },
  { label: 'Incidents', href: '/incidents' },
  { label: 'RPCs', href: '/tools/rpcs' },
  { label: 'BeeHive', href: '/beehive', badge: 'OPERATOR' },
];

export default function TabNav() {
  const pathname = usePathname();

  return (
    <div className="tab-nav" style={{
      display: 'flex', gap: 0, marginBottom: 24,
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',        // Firefox — hide scrollbar
      msOverflowStyle: 'none',       // IE/Edge
    }}>
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        const content = (
          <div className="tab-link" style={{
            padding: '12px 22px',
            fontFamily: 'Bebas Neue, sans-serif',
            fontSize: 16,
            letterSpacing: '0.1em',
            color: tab.disabled ? 'rgba(138,136,112,0.4)'
                 : isActive ? 'var(--gold)'
                 : 'var(--text-muted)',
            borderBottom: `2px solid ${isActive ? 'var(--gold)' : 'transparent'}`,
            marginBottom: -1,
            cursor: tab.disabled ? 'not-allowed' : 'pointer',
            transition: 'color 0.2s',
            display: 'flex', alignItems: 'center', gap: 10,
            whiteSpace: 'nowrap',
          }}>
            {tab.label}
            {tab.badge && (
              <span style={{
                fontSize: 9,
                letterSpacing: '0.1em',
                padding: '2px 7px',
                borderRadius: 4,
                background: 'rgba(201,168,76,0.12)',
                color: 'var(--gold-dim)',
                border: '1px solid rgba(201,168,76,0.2)',
              }}>
                {tab.badge}
              </span>
            )}
          </div>
        );
        if (tab.disabled) return <div key={tab.href}>{content}</div>;
        return <Link key={tab.href} href={tab.href} style={{ textDecoration: 'none' }}>{content}</Link>;
      })}
    </div>
  );
}
