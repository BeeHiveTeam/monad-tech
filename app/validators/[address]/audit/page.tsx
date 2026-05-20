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

interface AuditRecord {
  type: 'reward' | 'commission_change' | 'stake_change';
  blockNumber: number;
  timestamp: number | null;
  amount: string | null;
  validatorId: number;
  txHash: string | null;
  reason: string;
}

interface AuditResponse {
  address: string;
  network: string;
  moniker: string | null;
  commissionPct: number | null;
  validatorIds: number[];
  summary: {
    totalRewardsMon: string;
    rewardCount: number;
    blocksProduced: number;
    windowBlocks: number;
    scannedBlocks?: number;
    summaryComplete?: boolean;
    firstRewardBlock: number | null;
    lastRewardBlock: number | null;
  };
  rewards: AuditRecord[];
  fetchedAt: number;
  error?: string;
}

function formatBigMon(s: string | null): string {
  if (!s) return '—';
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M MON`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K MON`;
    return `${n.toFixed(4)} MON`;
  }
  return `${s} MON`;
}

export default function ValidatorAuditPage() {
  const params = useParams();
  const address = (params?.address as string ?? '').toLowerCase();
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowBlocks, setWindowBlocks] = useState(100_000);

  useEffect(() => {
    if (!address) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/validators/${address}/audit?network=${network}&windowBlocks=${windowBlocks}&limit=500`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { if (e?.name !== 'AbortError') setLoading(false); });
    return () => ctrl.abort();
  }, [address, network, windowBlocks]);

  const explorer = NETWORKS[network]?.explorer ?? 'https://testnet.monadscan.com';
  const liveState = loading ? 'loading' : 'live';

  const csvUrl = `/api/validators/${address}/audit?network=${network}&windowBlocks=${windowBlocks}&limit=5000&format=csv`;

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
            {' / '}
            <Link href={`/validators/${address}`} style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
              {data?.moniker || address.slice(0, 10) + '…'}
            </Link>
            {' / '}
            <span style={{ color: 'var(--text)' }}>Audit Trail</span>
          </div>

          {loading ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading audit data…
            </div>
          ) : data?.error ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: '#E05252' }}>
              {data.error}
            </div>
          ) : data ? (
            <>
              {/* Header */}
              <div className="card" style={{ padding: '24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
                  <div>
                    <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, color: 'var(--gold)', letterSpacing: '0.06em', lineHeight: 1.1, margin: 0, fontWeight: 400 }}>
                      Audit Trail — {data.moniker || 'Unknown'}
                    </h1>
                    <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                      {data.address}
                    </div>
                    {data.validatorIds.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                        Validator IDs: {data.validatorIds.join(', ')}
                      </div>
                    )}
                  </div>
                  <a
                    href={csvUrl}
                    download
                    style={{
                      padding: '8px 16px',
                      background: 'rgba(201,168,76,0.1)',
                      border: '1px solid var(--gold-dim)',
                      color: 'var(--gold)',
                      borderRadius: 4,
                      fontSize: 12,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      textDecoration: 'none',
                    }}
                  >
                    Export CSV
                  </a>
                </div>
              </div>

              {/* Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                <SummaryCard label="Total Rewards" value={formatBigMon(data.summary.totalRewardsMon)} />
                <SummaryCard label="Blocks Produced" value={data.summary.blocksProduced.toString()} />
                <SummaryCard label="Commission" value={data.commissionPct != null ? `${data.commissionPct}%` : '—'} />
                <SummaryCard label="Window" value={`${(data.summary.windowBlocks / 1000).toFixed(0)}K blocks`} />
              </div>

              {/* Partial-scan banner (M2): scan hit HARD_FETCH_CAP, summary
                  covers only `scannedBlocks` of the requested `windowBlocks`. */}
              {data.summary.summaryComplete === false && data.summary.scannedBlocks && (
                <div className="card" style={{ padding: '10px 14px', marginBottom: 12, border: '1px solid var(--gold-dim)', background: 'rgba(201,168,76,0.06)' }}>
                  <div style={{ fontSize: 11, color: 'var(--gold)', letterSpacing: '0.04em' }}>
                    ⚠ Partial scan — high reward volume hit the 5,000-event cap. Summary covers the most recent <strong>{(data.summary.scannedBlocks / 1000).toFixed(0)}K of {(data.summary.windowBlocks / 1000).toFixed(0)}K</strong> requested blocks. Narrow the window for a complete view, or use CSV export which streams the same partial set.
                  </div>
                </div>
              )}

              {/* Stale-data warning (M3): when most-recent reward is far from
                  the audit query time, flag that the validator may be inactive. */}
              {data.rewards.length > 0 && data.rewards[0].timestamp && (() => {
                const ageSec = data.fetchedAt / 1000 - data.rewards[0].timestamp;
                if (ageSec < 3600) return null;
                const hours = Math.floor(ageSec / 3600);
                return (
                  <div className="card" style={{ padding: '10px 14px', marginBottom: 12, border: '1px solid #E0525266', background: 'rgba(224,82,82,0.06)' }}>
                    <div style={{ fontSize: 11, color: '#E05252', letterSpacing: '0.04em' }}>
                      ⚠ Latest reward is <strong>{hours}h old</strong> (block {data.rewards[0].blockNumber.toLocaleString()}). Validator may be inactive, missing the active set, or producing very rarely. The reward ledger below is correct but not current.
                    </div>
                  </div>
                );
              })()}

              {/* Window selector */}
              <div className="card" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 12 }}>Audit window:</span>
                {[
                  { label: '10K blocks (~1h)', value: 10_000 },
                  { label: '100K blocks (~11h)', value: 100_000 },
                  { label: '500K blocks (~2.3d)', value: 500_000 },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setWindowBlocks(opt.value)}
                    style={{
                      marginRight: 8,
                      padding: '4px 10px',
                      background: windowBlocks === opt.value ? 'var(--gold-dim)' : 'transparent',
                      color: windowBlocks === opt.value ? 'var(--bg)' : 'var(--gold-dim)',
                      border: '1px solid var(--gold-dim)',
                      borderRadius: 3,
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Rewards table */}
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color: 'var(--gold)', letterSpacing: '0.06em' }}>
                    Reward Receipts ({data.rewards.length})
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Every block produced emits a `ValidatorRewarded` event. Each row = one audit receipt.
                  </div>
                </div>

                {data.rewards.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                    No reward events found in this window.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Block</th>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>When</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Amount</th>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>VID</th>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rewards.slice(0, 100).map((r, idx) => (
                        <tr key={`${r.blockNumber}-${idx}`} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 16px', fontFamily: 'DM Mono, monospace' }}>
                            <a href={`${explorer}/block/${r.blockNumber}`} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                              {r.blockNumber.toLocaleString()}
                            </a>
                          </td>
                          <td style={{ padding: '8px 16px', color: 'var(--text-muted)' }}>
                            {r.timestamp
                              ? formatDistanceToNow(new Date(r.timestamp * 1000), { addSuffix: true })
                              : '—'}
                          </td>
                          <td style={{ padding: '8px 16px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: '#4CAF6E' }}>
                            +{r.amount} MON
                          </td>
                          <td style={{ padding: '8px 16px', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
                            #{r.validatorId}
                          </td>
                          <td style={{ padding: '8px 16px', color: 'var(--text)', fontSize: 11 }}>
                            {r.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {data.rewards.length > 100 && (
                  <div style={{ padding: '12px 16px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                    Showing first 100 of {data.rewards.length}. Use CSV export for full data.
                  </div>
                )}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)' }}>
        {value}
      </div>
    </div>
  );
}
