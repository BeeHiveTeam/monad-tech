'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

type Range = '24h' | '7d' | '30d';

interface Item { key: string; visits: number }
interface Summary {
  range: string;
  totalVisits: number;
  uniqueVisitors: number;
  timeseries: Array<{ ts: number; visits: number }>;
  topPaths: Item[];
  topReferrers: Item[];
  topCountries: Item[];
  topBrowsers: Item[];
  topOs: Item[];
  topDevices: Item[];
  error?: string;
}

const RANGES: Array<{ key: Range; label: string }> = [
  { key: '24h', label: '24 hours' },
  { key: '7d',  label: '7 days'   },
  { key: '30d', label: '30 days'  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Bar({ label, value, max, extra }: { label: string; value: number; max: number; extra?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '200px 1fr 70px',
      gap: 12, alignItems: 'center',
      marginBottom: 4, fontFamily: 'DM Mono, monospace', fontSize: 11,
    }}>
      <span style={{
        color: 'var(--text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {label}
      </span>
      <div style={{ height: 6, background: 'rgba(201,168,76,0.1)', borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gold)', borderRadius: 3 }} />
      </div>
      <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
        {value.toLocaleString('en-US')}{extra ? ` · ${extra}` : ''}
      </span>
    </div>
  );
}

export default function AnalyticsPage() {
  const [network, setNetwork] = useNetwork();
  const [range, setRange] = useState<Range>('24h');
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/analytics/summary?range=${range}`, { cache: 'no-store' });
        const j = await r.json() as Summary;
        if (!cancelled) {
          if (!r.ok || j.error) setErr(j.error ?? `HTTP ${r.status}`);
          else setD(j);
        }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    })();
    const t = setInterval(() => {
      (async () => {
        try {
          const r = await fetch(`/api/analytics/summary?range=${range}`, { cache: 'no-store' });
          if (r.ok && !cancelled) setD(await r.json() as Summary);
        } catch { /* ignore */ }
      })();
    }, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [range]);

  const maxTs = d?.timeseries.reduce((m, p) => Math.max(m, p.visits), 0) ?? 0;

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} />
        <main className="site-main">
          <TabNav />

          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 36, letterSpacing: '0.04em', color: 'var(--gold)', marginBottom: 4 }}>
                Site Analytics
              </h1>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                In-house analytics in InfluxDB. No cookies. IP is not stored — a daily-rotated hash is used instead.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {RANGES.map(r => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  style={{
                    padding: '6px 14px', borderRadius: 4,
                    background: range === r.key ? 'var(--gold)' : 'transparent',
                    border: `1px solid ${range === r.key ? 'var(--gold)' : 'rgba(201,168,76,0.25)'}`,
                    color: range === r.key ? '#080808' : 'var(--text)',
                    fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, letterSpacing: '0.08em',
                    cursor: 'pointer',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {err && (
            <div className="card" style={{ padding: '16px 20px', color: '#E05252', fontSize: 12 }}>
              Error: {err}
            </div>
          )}

          {!d && !err && (
            <div className="card" style={{ padding: '16px 20px', color: 'var(--text-muted)' }}>
              Loading…
            </div>
          )}

          {d && (
            <>
              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 24, alignItems: 'flex-start',
                }}>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
                      TOTAL VISITS
                    </div>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 36, color: 'var(--gold)' }}>
                      {d.totalVisits.toLocaleString('en-US')}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
                      UNIQUE VISITORS
                    </div>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 36, color: 'var(--gold)' }}>
                      {d.uniqueVisitors.toLocaleString('en-US')}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
                      VISITS PER UNIQUE
                    </div>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 36, color: 'var(--gold)' }}>
                      {d.uniqueVisitors ? (d.totalVisits / d.uniqueVisitors).toFixed(2) : '—'}
                    </div>
                  </div>
                </div>
              </div>

              {d.timeseries.length > 0 && (
                <Section title="VISITS TIMELINE">
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${d.timeseries.length}, 1fr)`,
                    gap: 2, alignItems: 'flex-end',
                    height: 120, marginBottom: 6,
                  }}>
                    {d.timeseries.map(p => {
                      const h = maxTs > 0 ? (p.visits / maxTs) * 100 : 0;
                      return (
                        <div key={p.ts}
                          title={`${new Date(p.ts).toLocaleString('ru-RU')}: ${p.visits} visits`}
                          style={{
                            height: `${Math.max(h, 2)}%`,
                            background: 'var(--gold)', opacity: 0.8, borderRadius: 1,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{new Date(d.timeseries[0].ts).toLocaleString('ru-RU', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span>{new Date(d.timeseries[d.timeseries.length - 1].ts).toLocaleString('ru-RU', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </Section>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
                <Section title="TOP PAGES">
                  {d.topPaths.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No data yet.</div>
                  ) : (
                    d.topPaths.map(p => (
                      <Bar key={p.key} label={p.key} value={p.visits}
                        max={d.topPaths[0].visits}
                        extra={`${d.totalVisits ? ((p.visits / d.totalVisits) * 100).toFixed(1) : 0}%`} />
                    ))
                  )}
                </Section>

                <Section title="TOP REFERRERS">
                  {d.topReferrers.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No data yet.</div>
                  ) : (
                    d.topReferrers.map(p => (
                      <Bar key={p.key} label={p.key} value={p.visits} max={d.topReferrers[0].visits} />
                    ))
                  )}
                </Section>

                <Section title="COUNTRIES">
                  {d.topCountries.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      No country data — Cloudflare not proxying? (CF-IPCountry header missing)
                    </div>
                  ) : (
                    d.topCountries.map(p => (
                      <Bar key={p.key} label={p.key} value={p.visits} max={d.topCountries[0].visits} />
                    ))
                  )}
                </Section>

                <Section title="BROWSERS">
                  {d.topBrowsers.map(p => (
                    <Bar key={p.key} label={p.key} value={p.visits} max={d.topBrowsers[0]?.visits ?? 1} />
                  ))}
                </Section>

                <Section title="OPERATING SYSTEM">
                  {d.topOs.map(p => (
                    <Bar key={p.key} label={p.key} value={p.visits} max={d.topOs[0]?.visits ?? 1} />
                  ))}
                </Section>

                <Section title="DEVICE">
                  {d.topDevices.map(p => (
                    <Bar key={p.key} label={p.key} value={p.visits} max={d.topDevices[0]?.visits ?? 1} />
                  ))}
                </Section>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
