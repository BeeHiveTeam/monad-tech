'use client';
import { useEffect, useState } from 'react';

interface GeoData {
  fetchedAt: number | null;
  totalPeers: number;
  byCountry: Array<{ country: string; countryCode: string; count: number }>;
  byAsn: Array<{ asn: string; org: string; count: number }>;
  sampleIps?: number;
}

function fmtAge(ms: number | null): string {
  if (!ms) return '—';
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3600_000)}h ago`;
}

/**
 * Geographic distribution of OUR node's peer keepalive log (last 15 min).
 * Originally rendered on /network — moved here 2026-05-20 after audit
 * pointed out that 9 peers reflects the operator's local peer connections,
 * not the network's full ~270 validator geo. Belongs on the operator page.
 */
export default function PeerGeoCard() {
  const [geo, setGeo] = useState<GeoData | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/network-health', { signal: ctrl.signal, cache: 'no-store' })
      .then(r => r.json())
      .then(d => setGeo(d.geo))
      .catch(e => { if (e?.name !== 'AbortError') console.warn('peer-geo fetch failed', e); });
    return () => ctrl.abort();
  }, []);

  if (!geo) {
    return (
      <div className="card" style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>
        Loading peer geography…
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, color: 'var(--gold)', letterSpacing: '0.08em' }}>
          OUR PEER GEOGRAPHY
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          {geo.totalPeers} peers connected to <strong>this BeeHive validator</strong> in the last 15 minutes, geoloc via ip-api.com. Refreshed {fmtAge(geo.fetchedAt)}. This is the operator&apos;s local peer set, not the network&apos;s ~280-validator geographic distribution.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 24 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
            BY COUNTRY
          </div>
          {geo.byCountry.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No peers detected yet.</div>
          ) : geo.byCountry.map(c => {
            const pct = geo.totalPeers > 0 ? (c.count / geo.totalPeers) * 100 : 0;
            return (
              <div key={c.countryCode} style={{
                display: 'grid', gridTemplateColumns: '30px 1fr 60px',
                gap: 8, alignItems: 'center', marginBottom: 3,
                fontFamily: 'DM Mono, monospace', fontSize: 11,
              }}>
                <span style={{ color: 'var(--gold)' }}>{c.countryCode}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.country}</span>
                  <div style={{ flex: 1, height: 5, background: 'rgba(201,168,76,0.1)', borderRadius: 2 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gold)', borderRadius: 2 }} />
                  </div>
                </div>
                <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{c.count}</span>
              </div>
            );
          })}
        </div>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
            BY AS (HOSTING PROVIDER)
          </div>
          {geo.byAsn.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No AS data yet.</div>
          ) : geo.byAsn.slice(0, 10).map(a => {
            const pct = geo.totalPeers > 0 ? (a.count / geo.totalPeers) * 100 : 0;
            return (
              <div key={a.asn} style={{
                display: 'grid', gridTemplateColumns: '1fr 80px',
                gap: 8, alignItems: 'center', marginBottom: 3,
                fontFamily: 'DM Mono, monospace', fontSize: 11,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.org || a.asn}
                  </span>
                  <div style={{ flex: 1, height: 5, background: 'rgba(201,168,76,0.1)', borderRadius: 2 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gold)', borderRadius: 2 }} />
                  </div>
                </div>
                <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{a.count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
