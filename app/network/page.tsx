'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

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
    latestFetchedAt: number | null;
    isUpToDate: boolean | null;
    note: string;
  };
  reorgs: {
    recent: Array<{ ts: number; blockNumber: number; oldHash: string; newHash: string; depth: number }>;
    totalDetected: number;
    trackedBlocks: number;
    windowStart: number | null;
  };
  geo: {
    fetchedAt: number | null;
    totalPeers: number;
    byCountry: Array<{ country: string; countryCode: string; count: number }>;
    byAsn: Array<{ asn: string; org: string; count: number }>;
    sampleIps: number;
  };
  validatorSetChanges: {
    events: Array<{ ts: number; type: string; address: string; moniker?: string; oldStake?: number; newStake?: number; delta?: number }>;
    tracked: number;
  };
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', { hour12: false });
}

function fmtAge(ms: number | null): string {
  if (!ms) return '—';
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3600_000)}h ago`;
}

export default function NetworkPage() {
  const [network, setNetwork] = useNetwork();
  const [d, setD] = useState<NetworkHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/network-health', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as NetworkHealth;
        if (!cancelled) { setD(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} />
        <main className="site-main">
        <TabNav />

        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 42, letterSpacing: '0.04em', color: 'var(--gold)', marginBottom: 4 }}>
            Network Health
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Метрики децентрализации, версия клиента, реорги и география пиров — не публикуются в официальных инструментах.
            Данные собираются с нашей ноды: validator registry, RPC, journald через Loki.
          </div>
        </div>

        {err && !d && (
          <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
            Error: {err}
          </div>
        )}
        {!d && !err && (
          <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)' }}>Loading…</div>
        )}

        {d && (
          <>
            {/* Decentralization / Nakamoto */}
            <Section
              title="DECENTRALIZATION · NAKAMOTO COEFFICIENT"
              subtitle="Минимальное число валидаторов, чей суммарный stake превышает порог. BFT-safety требует >2/3, liveness-halt >1/3."
            >
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 24, marginBottom: 20,
              }}>
                {[
                  { label: 'NAKAMOTO 33% (liveness)', entry: d.decentralization.nakamoto.threshold33, warn: d.decentralization.nakamoto.threshold33.n < 4 },
                  { label: 'NAKAMOTO 50%',            entry: d.decentralization.nakamoto.threshold50, warn: false },
                  { label: 'NAKAMOTO 66% (safety)',   entry: d.decentralization.nakamoto.threshold66, warn: d.decentralization.nakamoto.threshold66.n < 7 },
                ].map(x => (
                  <div key={x.label}>
                    <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
                      {x.label}
                    </div>
                    <div style={{
                      fontFamily: 'DM Mono, monospace', fontSize: 36,
                      color: x.warn ? '#E05252' : 'var(--gold)', fontWeight: 500,
                    }}>
                      {x.entry.n}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(138,136,112,0.7)' }}>
                      cumulative: {x.entry.cumPct.toFixed(2)}%
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
                TOP-10 BY STAKE ({d.decentralization.top10SharePct.toFixed(2)}% of total)
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {d.decentralization.topValidators.map((v, i) => (
                  <div key={v.address} className="row-top10">
                    <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>#{i + 1}</span>
                    <span style={{
                      color: 'var(--text)', overflow: 'hidden', minWidth: 0,
                      whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                    }}>
                      {v.moniker ?? v.address}
                    </span>
                    <span style={{ color: 'var(--gold)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {v.stakeMon.toLocaleString('en-US', { maximumFractionDigits: 0 })} MON
                    </span>
                    <span className="col-share" style={{ color: 'rgba(138,136,112,0.7)', textAlign: 'right' }}>
                      {v.sharePct.toFixed(2)}%
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            {/* Client version moved to Node Monitor — see TAB "Node Monitor" */}

            {/* Reorgs */}
            <Section
              title="REORGS"
              subtitle="Определяются сверкой хэшей на tip/tip-1/tip-2 каждые 2с. Окно трекинга начинается с перезапуска сервиса."
            >
              <div style={{ display: 'flex', gap: 32, marginBottom: 14, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>DETECTED</div>
                  <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 28, color: d.reorgs.totalDetected > 0 ? '#E05252' : 'var(--gold)' }}>
                    {d.reorgs.totalDetected}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>TRACKED BLOCKS</div>
                  <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 14, color: 'var(--text)' }}>{d.reorgs.trackedBlocks}</div>
                </div>
              </div>
              {d.reorgs.recent.length === 0 ? (
                <div style={{ padding: '10px', fontSize: 11, color: 'var(--text-muted)', border: '1px dashed rgba(201,168,76,0.1)', borderRadius: 4 }}>
                  No reorgs detected in this window — chain is stable.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {d.reorgs.recent.map((r, i) => (
                    <div key={i} className="row-reorg">
                      <span className="col-time" style={{ color: 'var(--text-muted)' }}>{fmtTime(r.ts)}</span>
                      <span style={{ color: '#E05252' }}>block {r.blockNumber}</span>
                      <span style={{ color: 'var(--gold)', textAlign: 'right' }}>depth {r.depth}</span>
                      <span className="col-hash" style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {r.oldHash.slice(0, 12)}… → {r.newHash.slice(0, 12)}…
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Geo distribution */}
            <Section
              title="PEER GEO DISTRIBUTION"
              subtitle={`Из keepalive-логов валидатора, ${d.geo.totalPeers} пиров за последние 15 минут, geoloc via ip-api.com. Refreshed ${fmtAge(d.geo.fetchedAt)}.`}
            >
              <div className="grid-geo">
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
                    BY COUNTRY
                  </div>
                  {d.geo.byCountry.map(c => {
                    const pct = d.geo.totalPeers > 0 ? (c.count / d.geo.totalPeers) * 100 : 0;
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
                  {d.geo.byAsn.slice(0, 10).map(a => {
                    const pct = d.geo.totalPeers > 0 ? (a.count / d.geo.totalPeers) * 100 : 0;
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
            </Section>

            {/* Validator set changes */}
            <Section
              title="VALIDATOR SET CHANGES"
              subtitle={d.validatorSetChanges.events.length === 0
                ? `Tracking ${d.validatorSetChanges.tracked} validators. No changes observed since service start.`
                : `Stake decreases ≥1000 MON, removals, and additions since service start.`}
            >
              {d.validatorSetChanges.events.length === 0 ? (
                <div style={{ padding: '10px', fontSize: 11, color: 'var(--text-muted)', border: '1px dashed rgba(201,168,76,0.1)', borderRadius: 4 }}>
                  Monad testnet does not expose slashing events via RPC. Any future stake drop or removal will be surfaced here.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {d.validatorSetChanges.events.map((e, i) => (
                    <div key={i} className="row-valset">
                      <span className="col-time" style={{ color: 'var(--text-muted)' }}>{fmtTime(e.ts)}</span>
                      <span className="col-type" style={{
                        color: e.type === 'removed' ? '#E05252' : e.type === 'stake_decrease' ? '#E8A020' : 'var(--gold)',
                        textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em',
                      }}>
                        {e.type}
                      </span>
                      <span className="col-moniker" style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {e.moniker ?? e.address.slice(0, 16) + '…'}
                      </span>
                      <span className="col-delta" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                        {e.delta !== undefined ? `Δ ${e.delta.toLocaleString()} MON` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
        </main>
      </div>
    </>
  );
}
