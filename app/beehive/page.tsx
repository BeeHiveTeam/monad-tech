'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface BeeHiveData {
  operator: string;
  network: string;
  serviceName: string | null;
  clientVersion: string | null;
  ourBlockHeight: number;
  commits: { totalBlocks: number; totalTxs: number };
  peers: { active: number; pending: number; upstreamValidators: number };
  lastSeenMs: number;
  configured: {
    validatorAddress: string | null;
    commissionPct: number;
    minDelegation: number;
    twitter: string;
    discord: string;
    discordUrl: string | null;
    website: string;
  };
  fetchedAt: number;
}

interface NetworkStats {
  blockNumber: number;
}

function fmtAge(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3_600_000)}h ago`;
}

export default function BeeHivePage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<BeeHiveData | null>(null);
  const [netStats, setNetStats] = useState<NetworkStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [bhRes, statsRes] = await Promise.all([
          fetch('/api/beehive', { cache: 'no-store' }),
          fetch(`/api/stats?network=${network}`, { cache: 'no-store' }),
        ]);
        if (!bhRes.ok) throw new Error(`HTTP ${bhRes.status}`);
        const bh = await bhRes.json() as BeeHiveData;
        const st = statsRes.ok ? await statsRes.json() as NetworkStats : null;
        if (!cancelled) { setData(bh); setNetStats(st); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [network]);

  const isInSync = data && netStats
    ? Math.abs(data.ourBlockHeight - netStats.blockNumber) <= 2
    : false;
  const heightDelta = data && netStats ? data.ourBlockHeight - netStats.blockNumber : 0;
  const isHealthy = data && (Date.now() - data.lastSeenMs) < 30_000;

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader
          network={network}
          onNetworkChange={setNetwork}
          liveState="live"
          lastUpdate={null}
        />
        <main className="site-main">
          <TabNav />

          {/* HERO */}
          <div className="card" style={{
            padding: 32, marginBottom: 20,
            background: 'linear-gradient(135deg, rgba(201,168,76,0.08) 0%, rgba(8,8,8,0.6) 100%)',
            border: '1px solid rgba(201,168,76,0.3)',
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: 'auto 1fr auto',
              gap: 20, alignItems: 'center', flexWrap: 'wrap',
            }}>
              {/* Logo — bee-in-hexagon SVG extracted from bee-hive.work header
                  (not the B-letter favicon variant). Copied to /public/ as SVG
                  so it scales sharp at any size. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/beehive-logo.svg"
                alt="BeeHive logo"
                width={64}
                height={64}
                style={{ display: 'block' }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 32,
                  letterSpacing: '0.1em', lineHeight: 1,
                }}>
                  <span style={{ color: '#FFFFFF' }}>BEE</span>
                  <span style={{ color: 'var(--gold)' }}>HIVE</span>
                  <span style={{
                    color: 'var(--text-muted)', fontSize: 18,
                    marginLeft: 12, letterSpacing: '0.15em',
                  }}>VALIDATOR</span>
                </div>
                <div style={{
                  fontSize: 13, color: 'var(--text-muted)', marginTop: 6,
                  lineHeight: 1.5, maxWidth: 680,
                }}>
                  Professional Monad validator node. Transparent operations,
                  open observability, and 24/7 monitoring — all proved by the live
                  dashboard you&apos;re on right now.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                {isHealthy ? (
                  <span className="badge-green" style={{ fontSize: 11 }}>● NODE HEALTHY</span>
                ) : (
                  <span className="badge-red" style={{ fontSize: 11 }}>● NODE STALE</span>
                )}
                {data && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
                    last heartbeat {fmtAge(data.lastSeenMs)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* STATUS BANNER */}
          {data && !data.configured.validatorAddress && (
            <div style={{
              padding: '14px 20px', marginBottom: 16,
              background: 'rgba(232,160,32,0.08)',
              border: '1px solid rgba(232,160,32,0.3)',
              borderLeft: '3px solid #E8A020',
              borderRadius: 6, fontSize: 12, color: 'var(--text)',
            }}>
              <strong style={{ color: '#E8A020', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>
                Awaiting Delegation
              </strong>
              <span style={{ marginLeft: 10, color: 'var(--text-muted)' }}>
                Node is running and healthy. Needs 10M MON total delegation to enter the active set (currently 200 validators · Monad Foundation delegates 15–25B MON in year 1).
              </span>
            </div>
          )}

          {/* LIVE INFRA STATS */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 12, marginBottom: 20,
          }}>
            <Stat label="Client version" value={data?.clientVersion ?? '—'} accent />
            <Stat
              label="Our block height"
              value={data?.ourBlockHeight?.toLocaleString() ?? '—'}
              sub={data && netStats
                ? (isInSync ? '✓ in sync' : `Δ ${heightDelta} vs network`)
                : undefined}
              accent={isInSync}
              danger={!!data && !isInSync}
            />
            <Stat
              label="Active peers"
              value={data ? `${data.peers.active}` : '—'}
              sub={data ? `${data.peers.upstreamValidators} upstream validators` : undefined}
            />
            <Stat
              label="Blocks committed"
              value={data?.commits.totalBlocks.toLocaleString() ?? '—'}
              sub="lifetime counter"
            />
            <Stat
              label="TXs committed"
              value={data?.commits.totalTxs.toLocaleString() ?? '—'}
              sub="lifetime counter"
            />
            <Stat
              label="Commission"
              value={data?.configured.validatorAddress ? `${data.configured.commissionPct}%` : 'TBD'}
              sub={data?.configured.validatorAddress ? 'set on-chain' : 'set at activation'}
            />
          </div>

          {/* TWO COLUMN: Why us · Delegate CTA */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            gap: 16, marginBottom: 16,
          }}>
            {/* Why us */}
            <div className="card" style={{ padding: 24 }}>
              <h2 style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
                letterSpacing: '0.08em', color: 'var(--gold)',
                margin: 0, marginBottom: 14,
              }}>
                WHY BEEHIVE
              </h2>
              <ul style={{
                listStyle: 'none', padding: 0, margin: 0,
                fontSize: 13, color: 'var(--text)', lineHeight: 1.7,
              }}>
                {[
                  { t: 'Multi-chain experience', d: 'Running validators on Lido, Obol, SSV, Mina, Provenance, Stellar networks.' },
                  { t: 'Full transparency', d: 'This entire monitoring stack is public — every metric you see is real-time.' },
                  { t: 'Monad-native tooling', d: 'We built the parallel-execution, top-contracts and incident-timeline dashboards — unique to our infra.' },
                  { t: '24/7 monitoring', d: 'Loki log aggregation, Prometheus metrics, InfluxDB persistence, Cloudflare edge.' },
                  { t: '99.9% uptime SLA', d: 'Hardware redundancy, automatic failover, instrumented observability.' },
                ].map((it, i) => (
                  <li key={i} style={{
                    display: 'grid', gridTemplateColumns: '18px 1fr', gap: 10,
                    paddingBottom: 10, marginBottom: 10,
                    borderBottom: i < 4 ? '1px solid rgba(201,168,76,0.06)' : 'none',
                  }}>
                    <span style={{ color: 'var(--gold)', fontSize: 16, lineHeight: 1 }}>◆</span>
                    <div>
                      <div style={{ color: 'var(--text)', fontWeight: 500, fontSize: 13 }}>{it.t}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{it.d}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* Delegate CTA */}
            <div className="card" style={{
              padding: 24,
              background: 'linear-gradient(135deg, rgba(201,168,76,0.05) 0%, transparent 100%)',
            }}>
              <h2 style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
                letterSpacing: '0.08em', color: 'var(--gold)',
                margin: 0, marginBottom: 14,
              }}>
                DELEGATE TO BEEHIVE
              </h2>

              {data?.configured.validatorAddress ? (
                <div style={{
                  padding: 12, marginBottom: 14,
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  fontFamily: 'DM Mono, monospace', fontSize: 11,
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>
                    VALIDATOR ADDRESS
                  </div>
                  <div style={{ color: 'var(--gold)', wordBreak: 'break-all' }}>
                    {data.configured.validatorAddress}
                  </div>
                </div>
              ) : (
                <div style={{
                  padding: 12, marginBottom: 14, fontSize: 12,
                  color: 'var(--text-muted)', lineHeight: 1.6,
                  background: 'var(--surface2)',
                  border: '1px dashed rgba(201,168,76,0.2)', borderRadius: 6,
                }}>
                  Validator registration pending. Reach out via Twitter or Discord to
                  coordinate delegation — we&apos;re ready to enter the active set as soon
                  as sufficient stake is in place.
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                <a
                  href={`https://twitter.com/${data?.configured.twitter ?? 'BeeHive_NT'}`}
                  target="_blank" rel="noopener noreferrer"
                  style={ctaBtn}
                >
                  <span style={{ flex: 1 }}>Twitter / X</span>
                  <span style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                    @{data?.configured.twitter ?? 'BeeHive_NT'} ↗
                  </span>
                </a>
                {data?.configured.discordUrl ? (
                  <a
                    href={data.configured.discordUrl}
                    target="_blank" rel="noopener noreferrer"
                    style={ctaBtn}
                  >
                    <span style={{ flex: 1 }}>Discord</span>
                    <span style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                      {data.configured.discord} ↗
                    </span>
                  </a>
                ) : (
                  // No direct-link URL set — Discord has no public profile URL
                  // for usernames, so fall back to "open Discord + copy username".
                  // The user then pastes the username into Discord's search.
                  <a
                    href="https://discord.com/app"
                    target="_blank" rel="noopener noreferrer"
                    onClick={() => {
                      if (data?.configured.discord) {
                        navigator.clipboard.writeText(data.configured.discord).catch(() => {});
                      }
                    }}
                    title="Opens Discord in a new tab and copies the username to your clipboard"
                    style={ctaBtn}
                  >
                    <span style={{ flex: 1 }}>Discord</span>
                    <span style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                      {data?.configured.discord ?? 'mav3rick_iphone'} ↗ ⎘
                    </span>
                  </a>
                )}
                <a
                  href={data?.configured.website ?? 'https://bee-hive.work'}
                  target="_blank" rel="noopener noreferrer"
                  style={ctaBtn}
                >
                  <span style={{ flex: 1 }}>Main site</span>
                  <span style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                    bee-hive.work ↗
                  </span>
                </a>
              </div>

              <div style={{
                fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5,
                paddingTop: 12, borderTop: '1px solid var(--border)',
              }}>
                {data?.configured.validatorAddress ? (
                  <>
                    Commission: <strong style={{ color: 'var(--gold)' }}>{data.configured.commissionPct}%</strong> ·
                    {' '}Minimum delegation: <strong style={{ color: 'var(--gold)' }}>{data.configured.minDelegation} MON</strong>
                  </>
                ) : (
                  <>Commission and minimum delegation will be published on-chain when the validator enters the active set.</>
                )}
              </div>
            </div>
          </div>

          {/* Meta: pointer back to the live dashboard */}
          <div className="card" style={{
            padding: 20, marginBottom: 16,
            fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--gold)', fontSize: 15 }}>◆</span>
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong style={{ color: 'var(--text)' }}>Live proof of operation.</strong>
                {' '}Everything on this site — retry_pct metrics, top parallelism hotspots,
                incident timeline, validator health scores, reorg detection, peer geo —
                runs on this BeeHive node. You&apos;re not looking at marketing; you&apos;re
                looking at raw operational telemetry.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <a href="/" style={linkPill}>Network Status</a>
                <a href="/incidents" style={linkPill}>Incidents</a>
              </div>
            </div>
          </div>

          {err && (
            <div style={{
              padding: 12, fontSize: 11, color: '#E05252',
              border: '1px solid rgba(224,82,82,0.3)', borderRadius: 6,
            }}>
              {err}
            </div>
          )}
        </main>
      </div>
    </>
  );
}

function Stat({ label, value, sub, accent, danger }: {
  label: string; value: string | number; sub?: string;
  accent?: boolean; danger?: boolean;
}) {
  return (
    <div className="card" style={{
      padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <span style={{
        fontSize: 10, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'Bebas Neue, sans-serif', fontSize: 22,
        letterSpacing: '0.04em', lineHeight: 1,
        color: danger ? '#E05252' : accent ? 'var(--gold)' : 'var(--text)',
      }}>
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 11, color: danger ? '#E05252' : 'var(--text-muted)' }}>{sub}</span>
      )}
    </div>
  );
}

const ctaBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 14px',
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  textDecoration: 'none',
  color: 'var(--text)',
  fontSize: 12,
  transition: 'border-color 0.15s, background 0.15s',
};

const linkPill: React.CSSProperties = {
  padding: '5px 10px',
  background: 'rgba(201,168,76,0.08)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--gold)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  textDecoration: 'none',
  fontFamily: 'Bebas Neue, sans-serif',
};
