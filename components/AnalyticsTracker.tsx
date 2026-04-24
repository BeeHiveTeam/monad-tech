'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Fires a page-view to /api/analytics/track on initial load and on every
// client-side route change. Fire-and-forget — failures are silent and
// never block the UI.
export default function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    const referrer = document.referrer || null;
    fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathname, referrer }),
      keepalive: true,   // allow the request to survive navigation
    }).catch(() => {});
  }, [pathname]);

  return null;
}
