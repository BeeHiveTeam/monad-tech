'use client';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';
import { NETWORKS } from '@/lib/networks';
import { formatDistanceToNow } from 'date-fns';
import DelegatorsPanel from '@/components/DelegatorsPanel';

type Health = 'active' | 'slow' | 'missing' | 'unknown';

interface ValidatorDetail {
  address: string;
  info: {
    moniker?: string;
    website?: string;
    description?: string;
    logo?: string;
    x?: string;
    validatorId?: number;
    secp?: string;
    stakeMon?: number;
    commissionPct?: number;
  } | null;
  stats: {
    health: Health;
    score: number;
    blocksProduced: number;
    totalTxs: number;
    sharePct: number;
    participationPct: number;
    ageSeconds: number;
    lastBlockTs: number;
  };
  context: {
    sampleSize: number;
    producersInWindow: number;
    expectedGapSeconds: number;
    windowSeconds: number;
  };
  recentBlocks: { number: number; timestamp: number; txCount: number; hash: string }[];
  fetchedAt: number;
  error?: string;
}

const HEALTH_STYLE: Record<Health, { bg: string; fg: string; label: string }> = {
  active:  { bg: 'rgba(76,175,110,0.14)',  fg: '#4CAF6E', label: 'ACTIVE' },
  slow:    { bg: 'rgba(201,168,76,0.14)',  fg: '#C9A84C', label: 'SLOW' },
  missing: { bg: 'rgba(224,82,82,0.14)',   fg: '#E05252', label: 'MISSING' },
  unknown: { bg: 'rgba(138,136,112,0.14)', fg: '#8A8870', label: 'UNKNOWN' },
};

function scoreColor(s: number) {
  return s >= 75 ? '#4CAF6E' : s >= 45 ? '#C9A84C' : '#E05252';
}

function formatStake(mon: number | undefined): string {
  if (mon == null) return '—';
  if (mon >= 1_000_000) return `${(mon / 1_000_000).toFixed(1)}M MON`;
  if (mon >= 1_000) return `${(mon / 1_000).toFixed(0)}K MON`;
  return `${mon.toFixed(0)} MON`;
}

function formatCommission(pct: number | undefined): string {
  if (pct == null) return '—';
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

function xHandle(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
  return m ? `@${m[1]}` : url;
}

function Field({ label, value, mono, link }: {
  label: string; value?: string | null; mono?: boolean; link?: string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', alignSelf: 'center' }}>
        {label}
      </span>
      {value ? (
        link ? (
          <a href={link} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: mono ? 'DM Mono, monospace' : undefined, fontSize: 13, color: 'var(--gold)', wordBreak: 'break-all' }}>
            {value}
          </a>
        ) : (
          <span style={{ fontFamily: mono ? 'DM Mono, monospace' : undefined, fontSize: 13, color: 'var(--text)', wordBreak: 'break-all' }}>
            {value}
          </span>
        )
      ) : (
        <span style={{ fontSize: 12, color: 'rgba(138,136,112,0.45)', fontStyle: 'italic' }}>—</span>
      )}
    </div>
  );
}

export default function ValidatorDetailPage() {
  const params = useParams();
  const address = (params?.address as string ?? '').toLowerCase();
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<ValidatorDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    fetch(`/api/validators/${address}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [address]);

  const explorer = NETWORKS[network]?.explorer ?? 'https://testnet.monadscan.com';
  const liveState = loading ? 'loading' : 'live';

  const hs = data ? HEALTH_STYLE[data.stats?.health ?? 'unknown'] : HEALTH_STYLE.unknown;
  const sc = data?.stats?.score ?? 0;

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={liveState} lastUpdate={null} />

        <main className="site-main">
          <TabNav />

          {/* Breadcrumb */}
          <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
            <Link href="/validators" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
              ← Validators
            </Link>
          </div>

          {loading ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading validator data…
            </div>
          ) : data?.error ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: '#E05252' }}>
              {data.error}
            </div>
          ) : data ? (
            <>
              {/* Header card */}
              <div className="card" style={{ padding: '24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
                  {/* Score circle */}
                  <div style={{
                    width: 72, height: 72, borderRadius: '50%', flexShrink: 0,
                    border: `3px solid ${scoreColor(sc)}`,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    background: `${scoreColor(sc)}15`,
                  }}>
                    <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: scoreColor(sc), lineHeight: 1 }}>{sc}</span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>SCORE</span>
                  </div>

                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.06em', lineHeight: 1.1 }}>
                      {data.info?.moniker ?? 'Unknown Validator'}
                    </div>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                      {data.address}
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '4px 12px', borderRadius: 12,
                        background: hs.bg, color: hs.fg,
                        fontSize: 11, letterSpacing: '0.08em',
                        border: `1px solid ${hs.fg}33`,
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: hs.fg,
                          animation: data.stats.health === 'active' ? 'pulse 2s infinite' : 'none' }} />
                        {hs.label}
                      </span>
                      {data.stats.lastBlockTs > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          last block {formatDistanceToNow(new Date(data.stats.lastBlockTs * 1000), { addSuffix: true })}
                        </span>
                      )}
                      <a
                        href={`${explorer}/address/${data.address}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: 'var(--gold-dim)', textDecoration: 'none', opacity: 0.7 }}
                        title="External MonadScan view (third-party)"
                      >
                        Also on MonadScan ↗
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stats row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
                {[
                  { label: 'Stake', value: formatStake(data.info?.stakeMon) },
                  { label: 'Commission', value: formatCommission(data.info?.commissionPct) },
                  { label: 'Blocks produced', value: data.stats.blocksProduced.toLocaleString('en-US') },
                  { label: 'Block share', value: `${data.stats.sharePct.toFixed(2)}%` },
                  { label: 'Participation', value: `${Math.min(data.stats.participationPct, 100).toFixed(0)}%`,
                    sub: data.stats.participationPct > 100 ? `raw ${data.stats.participationPct.toFixed(0)}% (high stake)` : undefined },
                  { label: 'Total txs', value: data.stats.totalTxs.toLocaleString('en-US') },
                  { label: 'Sample size', value: `${data.context.sampleSize.toLocaleString()} blocks` },
                  { label: 'Producers in window', value: data.context.producersInWindow.toString() },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: '14px 18px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, color: 'var(--gold)', letterSpacing: '0.04em' }}>{s.value}</div>
                    {s.sub && <div style={{ fontSize: 10, color: 'rgba(138,136,112,0.6)', marginTop: 2 }}>{s.sub}</div>}
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginBottom: 16 }}>
                {/* Registry info */}
                <div className="card" style={{ padding: '20px 24px' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 14 }}>
                    VALIDATOR INFO
                  </div>
                  <Field label="Moniker" value={data.info?.moniker} />
                  <Field label="Status" value={hs.label} />
                  <Field label="Validator ID" value={data.info?.validatorId?.toString()} />
                  <Field label="Auth Address" value={data.address} mono />
                  <Field label="Public Key (secp)" value={data.info?.secp} mono />
                  <Field label="Website" value={data.info?.website}
                    link={data.info?.website} />
                  <Field label="X / Twitter" value={xHandle(data.info?.x)}
                    link={data.info?.x} />
                  <Field label="Description" value={data.info?.description} />

                  <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(138,136,112,0.5)', lineHeight: 1.5 }}>
                    Stake and Commission are read from the staking precompile (slot 4 / 8). Moniker,
                    Website, X and Description come from the{' '}
                    <a href="https://github.com/monad-developers/validator-info" target="_blank" rel="noopener noreferrer"
                      style={{ color: 'var(--gold-dim)' }}>
                      monad-developers/validator-info
                    </a>{' '}registry and refresh every hour.
                  </div>
                </div>

                {/* Recent blocks */}
                <div className="card" style={{ padding: '20px 24px' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 14 }}>
                    RECENT BLOCKS ({data.recentBlocks.length})
                  </div>
                  {data.recentBlocks.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                      No blocks found in last {data.context.sampleSize} sampled
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Block</th>
                            <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Txs</th>
                            <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Age</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.recentBlocks.map(b => (
                            <tr key={b.number}>
                              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                                <Link
                                  href={`/block/${b.number}`}
                                  style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}
                                >
                                  #{b.number.toLocaleString('en-US')}
                                </Link>
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                                {b.txCount}
                              </td>
                              <td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                {formatDistanceToNow(new Date(b.timestamp * 1000), { addSuffix: true })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
              {/* Delegation activity — staking-precompile transactions targeting this address */}
              <DelegatorsPanel address={data.address} />
            </>
          ) : null}

          <div style={{ textAlign: 'center', marginTop: 40, paddingBottom: 32, color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em' }}>
            <Link href="/validators" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>BeeHive</Link>
            {' '}·{' '}Monad Network Monitor
          </div>
        </main>
      </div>
    </>
  );
}
