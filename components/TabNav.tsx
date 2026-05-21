'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface Tab {
  label: string;
  href: string;
  disabled?: boolean;
  badge?: string;
}

// "Delegate" tab was removed 2026-05-21: it pointed to /validators?view=delegator
// which is the SAME page as Validators — only the in-page view toggle differed.
// Having two tabs for one page made the site look like there were two
// validator sections. Now: one "Validators" tab; users switch view via the
// OPERATOR/DELEGATOR toggle inside the page. /delegate URL still redirects
// for old bookmarks.
const TABS: Tab[] = [
  { label: 'Network Status', href: '/' },
  { label: 'Validators', href: '/validators' },
  { label: 'My Delegations', href: '/my-delegations', badge: 'NEW' },
  { label: 'Network Health', href: '/network' },
  { label: 'Incidents', href: '/incidents' },
  { label: 'Tools', href: '/tools' },
  { label: 'BeeHive', href: '/beehive', badge: 'OPERATOR' },
];

export default function TabNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = activeRef.current;
    if (active && nav.scrollWidth > nav.clientWidth) {
      const target = active.offsetLeft + active.offsetWidth / 2 - nav.clientWidth / 2;
      nav.scrollLeft = Math.max(0, Math.min(target, nav.scrollWidth - nav.clientWidth));
    }
    const update = () => {
      setFades({
        left: nav.scrollLeft > 4,
        right: nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 4,
      });
    };
    update();
    nav.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      nav.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [pathname]);

  return (
    <div style={{ position: 'relative', marginBottom: 24 }}>
    <div ref={navRef} className="tab-nav" style={{
      display: 'flex', gap: 0,
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',        // Firefox — hide scrollbar
      msOverflowStyle: 'none',       // IE/Edge
    }}>
      {TABS.map((tab) => {
        // Tab matching logic:
        //  - /tools highlights for hub and sub-routes
        //  - /validators highlights for both operator and delegator views
        //    (?view=delegator is in-page toggle, not a separate tab)
        //  - everything else uses exact pathname match
        const isActive = tab.href === '/tools'
          ? (pathname === '/tools' || pathname.startsWith('/tools/'))
          : tab.href === '/validators'
            ? (pathname === '/validators' || pathname.startsWith('/validators/'))
          : pathname === tab.href;
        const content = (
          <div ref={isActive ? activeRef : undefined} className="tab-link" style={{
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
    {fades.left && (
      <div aria-hidden style={{
        position: 'absolute', top: 0, left: 0, bottom: 1,
        width: 36, pointerEvents: 'none',
        background: 'linear-gradient(to left, rgba(8,8,8,0), var(--black))',
      }} />
    )}
    {fades.right && (
      <div aria-hidden style={{
        position: 'absolute', top: 0, right: 0, bottom: 1,
        width: 36, pointerEvents: 'none',
        background: 'linear-gradient(to right, rgba(8,8,8,0), var(--black))',
      }} />
    )}
    </div>
  );
}
