'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface NakamotoEntry { n: number; cumPct: number }
interface TopValidator { address: string; moniker: string | null; stakeMon: number; sharePct: number }
interface NetworkHealth {
  fetchedAt: number;
  decentralization: {
    totalValidators: number;
    activeValidators: number;
    totalStakeMon: number;
    nakamoto: { threshold33: NakamotoEntry; threshold50: NakamotoEntry; threshold66: NakamotoEntry };
    top10SharePct: number;
    topValidators: TopValidator[];
  };
  clientVersion: {
    rpc: string | null;
    fetchedAt: number | null;
    latest: string | null;
    latestUrl: string | null;
    isUpToDate: boolean | null;
    note: string;
  };
  reorgs: { recent: Array<{ ts: number; blockNumber: number; depth: number }>; totalDetected: number; trackedBlocks: number };
  geo: {
    fetchedAt: number | null;
    totalPeers: number;
    byCountry: Array<{ country: string; countryCode: string; count: number }>;
    byAsn: Array<{ asn: string; org: string; count: number }>;
    sampleIps: number;
  };
  validatorSetChanges: {
    events: Array<{ ts: number; type: string; address: string; moniker?: string; oldStake?: number; newStake?: number }>;
    tracked: number;
  };
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 22, color: 'var(--gold)' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 10, color: 'rgba(138,136,112,0.7)' }}>{sub}</span>}
    </div>
  );
}

export default function NetworkHealthCard() {
  const [d, setD] = useState<NetworkHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/network-health', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as NetworkHealth;
        if (!cancelled) setD(j);
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (err && !d) {
    return (
      <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
        Network health error: {err}
      </div>
    );
  }
  if (!d) {
    return (
      <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)', fontSize: 13 }}>
        Loading network health…
      </div>
    );
  }

  const dc = d.decentralization;
  const totalPeers = d.geo.totalPeers;
  const topCountries = d.geo.byCountry.slice(0, 5);
  const ccPct = (n: number) => totalPeers > 0 ? (n / totalPeers) * 100 : 0;

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)' }}>
            NETWORK HEALTH
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Decentralization, client, reorgs, peer geography — metrics not exposed by official tools.
          </div>
        </div>
        <Link href="/network" style={{
          fontSize: 10, letterSpacing: '0.08em', color: 'var(--gold)',
          textDecoration: 'none', border: '1px solid rgba(201,168,76,0.3)',
          padding: '6px 12px', borderRadius: 4,
        }}>
          DETAILS →
        </Link>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 20, marginBottom: 18,
      }}>
        <Metric
          label="Nakamoto (33%)"
          value={dc.nakamoto.threshold33.n}
          sub={`min validators to halt liveness (>1/3 stake)`}
        />
        <Metric
          label="Nakamoto (66%)"
          value={dc.nakamoto.threshold66.n}
          sub={`min validators for safety attack (>2/3)`}
        />
        <Metric
          label="Top-10 stake"
          value={`${dc.top10SharePct.toFixed(1)}%`}
          sub={`of ${dc.activeValidators} active validators`}
        />
        <Metric
          label="Reorgs detected"
          value={d.reorgs.totalDetected}
          sub={`tracked ${d.reorgs.trackedBlocks} blocks`}
        />
        <Metric
          label="Peer mesh"
          value={totalPeers}
          sub={`${d.geo.byCountry.length} countries, ${d.geo.byAsn.length} ASNs`}
        />
      </div>

      {topCountries.length > 0 && (
        <div>
          <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 8 }}>
            PEER GEO DISTRIBUTION
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {topCountries.map(c => (
              <div key={c.countryCode} style={{
                display: 'grid',
                // Cols: 2-letter flag code | country name | progress bar | peers | %
                gridTemplateColumns: '32px 150px 1fr 50px 56px',
                gap: 12, alignItems: 'center',
                fontFamily: 'DM Mono, monospace', fontSize: 11,
              }}>
                <span style={{
                  color: 'var(--gold)', textAlign: 'center',
                  letterSpacing: '0.04em', fontWeight: 500,
                }}>
                  {c.countryCode}
                </span>
                <span style={{
                  color: 'var(--text)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {c.country}
                </span>
                <div style={{ height: 5, background: 'rgba(201,168,76,0.1)', borderRadius: 3 }}>
                  <div style={{
                    width: `${ccPct(c.count)}%`, height: '100%',
                    background: 'var(--gold)', borderRadius: 3,
                  }} />
                </div>
                <span style={{ color: 'var(--text)', textAlign: 'right' }}>
                  {c.count}
                </span>
                <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                  {ccPct(c.count).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
