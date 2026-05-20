'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart,
} from 'recharts';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface NakamotoEntry { n: number; cumPct: number }
interface OperatorRow {
  authAddress: string;
  moniker: string | null;
  stakeMon: number;
  sharePct: number;
  cumulativeSharePct: number;
  validatorIds: number[];
}

interface ConcentrationData {
  network: string;
  fetchedAt: number;
  building?: boolean;
  summary: {
    validatorIdCount: number;
    operatorCount: number;
    totalStakeMon: number;
    idsPerOperatorAvg: number;
  };
  nakamoto: {
    threshold33: NakamotoEntry;
    threshold50: NakamotoEntry;
    threshold66: NakamotoEntry;
  };
  gini: number;
  multiIdOperators: Array<{
    authAddress: string; moniker: string | null; validatorIds: number[];
    stakeMon: number; sharePct: number;
  }>;
  top20: OperatorRow[];
  cumulativeByRank: Array<{ rank: number; moniker: string | null; sharePct: number; cumulativeSharePct: number }>;
  lorenz: Array<{ x: number; y: number }>;
  geoNote: string;
}

function fmtStake(mon: number): string {
  if (mon >= 1_000_000) return `${(mon / 1_000_000).toFixed(1)}M MON`;
  if (mon >= 1_000) return `${(mon / 1_000).toFixed(0)}K MON`;
  return `${mon.toFixed(0)} MON`;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function giniColor(g: number): string {
  if (g < 0.40) return '#4CAF6E';   // healthy
  if (g < 0.60) return '#C9A84C';   // caution
  return '#E05252';                  // concentration risk
}

function nakamotoColor(n: number, threshold: 33 | 50 | 66): string {
  // Higher n = more decentralized = better.
  // Healthy: ≥7 (BFT), ≥10 (good), ≥15 (excellent)
  if (threshold === 33) {
    if (n >= 15) return '#4CAF6E';
    if (n >= 7) return '#C9A84C';
    return '#E05252';
  }
  if (threshold === 66) {
    if (n >= 30) return '#4CAF6E';
    if (n >= 15) return '#C9A84C';
    return '#E05252';
  }
  if (n >= 20) return '#4CAF6E';
  if (n >= 10) return '#C9A84C';
  return '#E05252';
}

export default function ConcentrationPage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<ConcentrationData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/network/concentration?network=${network}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [network]);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={loading ? 'loading' : 'live'} lastUpdate={null} />

        <main className="site-main">
          <TabNav />

          {/* Breadcrumb */}
          <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
            <Link href="/network" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
              ← Network Health
            </Link>
            {' / '}
            <span style={{ color: 'var(--text)' }}>Concentration Deep-Dive</span>
          </div>

          {/* Header */}
          <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.06em', lineHeight: 1.1 }}>
              Stake Concentration
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, maxWidth: 760 }}>
              How decentralized is the active set? Nakamoto coefficient (min operators to halt liveness / control safety), Gini coefficient, Lorenz curve, and multi-ID operator clustering. All numbers roll up at the <em>authAddress</em> level — multi-ID operators (e.g. one operator running 4 validator IDs) are counted as a single operator.
            </div>
          </div>

          {loading || !data ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading concentration data…
            </div>
          ) : data.building ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              {data.summary ? `Operators: ${data.summary.operatorCount}` : 'Validator registry is still loading. Refresh in a few seconds.'}
            </div>
          ) : (
            <>
              {/* Summary tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                <Tile label="Validator IDs" value={data.summary.validatorIdCount.toString()} />
                <Tile label="Distinct Operators" value={data.summary.operatorCount.toString()} />
                <Tile label="IDs / Operator avg" value={data.summary.idsPerOperatorAvg.toString()} />
                <Tile label="Total Active Stake" value={fmtStake(data.summary.totalStakeMon)} />
              </div>

              {/* Nakamoto cards */}
              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 6 }}>
                  Nakamoto Coefficient
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
                  Minimum operators whose combined stake exceeds the BFT threshold. <strong>n₃₃</strong> can halt liveness, <strong>n₆₆</strong> controls safety. Higher = more decentralized.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <NakamotoTile label="33% threshold (liveness halt)" value={data.nakamoto.threshold33.n} color={nakamotoColor(data.nakamoto.threshold33.n, 33)} cumPct={data.nakamoto.threshold33.cumPct} />
                  <NakamotoTile label="50% threshold (majority)"      value={data.nakamoto.threshold50.n} color={nakamotoColor(data.nakamoto.threshold50.n, 50)} cumPct={data.nakamoto.threshold50.cumPct} />
                  <NakamotoTile label="66% threshold (safety control)" value={data.nakamoto.threshold66.n} color={nakamotoColor(data.nakamoto.threshold66.n, 66)} cumPct={data.nakamoto.threshold66.cumPct} />
                  <div style={{
                    padding: 14, border: '1px solid var(--border)', borderRadius: 4,
                    background: `${giniColor(data.gini)}10`,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
                      Gini coefficient
                    </div>
                    <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: giniColor(data.gini), lineHeight: 1 }}>
                      {data.gini.toFixed(3)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                      0 = perfect equality, 1 = one operator owns all
                    </div>
                  </div>
                </div>
              </div>

              {/* Lorenz + cumulative curves */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 16, marginBottom: 16 }}>
                <div className="card" style={{ padding: '20px 24px' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Lorenz Curve
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                    X = operator rank percentile (ascending by stake). Y = cumulative stake share. The straight diagonal is perfect equality; the further the curve bends below, the higher the concentration.
                  </div>
                  <div style={{ height: 260 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.lorenz}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(201,168,76,0.1)" />
                        <XAxis dataKey="x" type="number" domain={[0, 100]} tick={{ fill: '#8A8870', fontSize: 10 }} label={{ value: 'Operators (cum %)', position: 'insideBottom', offset: -4, fill: '#8A8870', fontSize: 10 }} />
                        <YAxis domain={[0, 100]} tick={{ fill: '#8A8870', fontSize: 10 }} label={{ value: 'Stake (cum %)', angle: -90, position: 'insideLeft', fill: '#8A8870', fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: '#1A1810', border: '1px solid var(--gold-dim)', borderRadius: 4, fontSize: 11 }}
                          formatter={(v) => `${Number(v).toFixed(1)}%`}
                        />
                        <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="rgba(76,175,110,0.4)" strokeDasharray="4 4" />
                        <Line type="monotone" dataKey="y" stroke="#C9A84C" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card" style={{ padding: '20px 24px' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Cumulative Stake by Rank
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                    Top-N operators (descending by stake). Steeper early rise = more whale-dominated.
                  </div>
                  <div style={{ height: 260 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.cumulativeByRank.slice(0, 50)}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(201,168,76,0.1)" />
                        <XAxis dataKey="rank" tick={{ fill: '#8A8870', fontSize: 10 }} label={{ value: 'Operator rank', position: 'insideBottom', offset: -4, fill: '#8A8870', fontSize: 10 }} />
                        <YAxis domain={[0, 100]} tick={{ fill: '#8A8870', fontSize: 10 }} label={{ value: 'Cum stake %', angle: -90, position: 'insideLeft', fill: '#8A8870', fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: '#1A1810', border: '1px solid var(--gold-dim)', borderRadius: 4, fontSize: 11 }}
                          formatter={(v) => `${Number(v).toFixed(2)}%`}
                          labelFormatter={(r) => {
                            const row = data.cumulativeByRank.find(x => x.rank === r);
                            return row ? `#${r} — ${row.moniker || 'unknown'}` : `Rank ${r}`;
                          }}
                        />
                        <Area type="monotone" dataKey="cumulativeSharePct" stroke="#C9A84C" fill="#C9A84C" fillOpacity={0.18} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Multi-ID operators */}
              {data.multiIdOperators.length > 0 && (
                <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Multi-ID Operators ({data.multiIdOperators.length})
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Operators running more than one validator ID under a single auth address. Their total stake is what counts for BFT decentralization — counting each ID separately overstates the operator population.
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Operator</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Validator IDs</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Stake</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.multiIdOperators.map(op => (
                        <tr key={op.authAddress} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px' }}>
                            <Link href={`/validators/${op.authAddress}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                              {op.moniker || shortAddr(op.authAddress)}
                            </Link>
                          </td>
                          <td style={{ padding: '8px 12px', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
                            {op.validatorIds.join(', ')} ({op.validatorIds.length})
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{fmtStake(op.stakeMon)}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: op.sharePct >= 5 ? '#E05252' : 'var(--gold)' }}>{op.sharePct.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Top-20 operators */}
              <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, color: 'var(--gold)', letterSpacing: '0.08em' }}>
                    Top-20 Operators
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                      <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>#</th>
                      <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Operator</th>
                      <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>IDs</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Stake</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Share</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Cumulative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top20.map((op, i) => (
                      <tr key={op.authAddress} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>{i + 1}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <Link href={`/validators/${op.authAddress}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                            {op.moniker || shortAddr(op.authAddress)}
                          </Link>
                        </td>
                        <td style={{ padding: '8px 12px', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>{op.validatorIds.length}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{fmtStake(op.stakeMon)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{op.sharePct.toFixed(2)}%</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>{op.cumulativeSharePct.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Geo placeholder */}
              <div className="card" style={{ padding: '16px 20px', marginBottom: 16, borderStyle: 'dashed', borderColor: 'var(--gold-dim)' }}>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, color: 'var(--gold-dim)', letterSpacing: '0.08em', marginBottom: 4 }}>
                  Geographic & AS Concentration — Coming Soon
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {data.geoNote}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)' }}>{value}</div>
    </div>
  );
}

function NakamotoTile({ label, value, color, cumPct }: { label: string; value: number; color: string; cumPct: number }) {
  return (
    <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 4, background: `${color}10` }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 30, color, lineHeight: 1 }}>
          {value}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>operators</div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
        their cumulative stake: {cumPct.toFixed(1)}%
      </div>
    </div>
  );
}
