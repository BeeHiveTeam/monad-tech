'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface Position {
  validatorId: number;
  authAddress: string;
  moniker: string | null;
  stakeMon: number;
  commissionPct: number | null;
  isActiveSet: boolean;
}

interface Resp {
  network: string;
  address: string;
  positionCount: number;
  totalStakeMon: number;
  validatorsScanned: number;
  positions: Position[];
  fetchedAt: number;
  building?: boolean;
  error?: string;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(4);
}

export default function MyDelegationsPage() {
  const [network, setNetwork] = useNetwork();
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!submitted) return;
    const ctrl = new AbortController();
    setLoading(true);
    setErr(null);
    fetch(`/api/my-delegations?address=${submitted}&network=${network}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then((d: Resp) => {
        if (d.error) setErr(d.error);
        else setData(d);
        setLoading(false);
      })
      .catch(e => { if (e?.name !== 'AbortError') { setErr(String(e)); setLoading(false); } });
    return () => ctrl.abort();
  }, [submitted, network]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = input.trim().toLowerCase();
    if (!ADDR_RE.test(v)) {
      setErr('Address must be 0x + 40 hex characters.');
      return;
    }
    setErr(null);
    setData(null);
    setSubmitted(v);
  };

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={loading ? 'loading' : 'live'} lastUpdate={null} />
        <main className="site-main">
          <TabNav />

          <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.06em', margin: 0, fontWeight: 400 }}>
              My delegations
            </h1>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, maxWidth: 760, lineHeight: 1.5 }}>
              Paste your wallet address — we&apos;ll scan every Monad validator in the registry and
              return every position you have. Live read from the staking precompile,
              no third-party indexer. 60-second cache per address.
            </div>
          </div>

          <form onSubmit={onSubmit} className="card" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="0xYourDelegatorAddress..."
              style={{
                flex: 1, minWidth: 280,
                padding: '8px 12px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--gold-dim)',
                color: 'var(--text)',
                fontFamily: 'DM Mono, monospace', fontSize: 13,
                borderRadius: 3,
              }}
            />
            <button type="submit" style={{
              padding: '8px 18px',
              background: 'rgba(201,168,76,0.1)',
              border: '1px solid var(--gold-dim)',
              color: 'var(--gold)',
              fontSize: 12, letterSpacing: '0.06em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              borderRadius: 3,
            }}>
              Scan
            </button>
          </form>

          {/* Sample address hint — empty state pre-fix had no way for first-time
              visitors to try the feature without remembering a 0x address.
              Pre-fills the Foundation delegator (~266 positions, fast demo). */}
          {!submitted && !err && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text)' }}>Don&apos;t have an address handy?</strong>{' '}
              Try the Monad Foundation delegator{' '}
              <button
                type="button"
                onClick={() => setInput('0xf235ab9b2f80a9569079c0d62aab91024f4dd61e')}
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  color: 'var(--gold-dim)', cursor: 'pointer', textDecoration: 'underline',
                  fontFamily: 'DM Mono, monospace', fontSize: 11,
                }}
                title="Pre-fill with Foundation delegator address (~266 positions / 2.79B MON)"
              >
                0xf235ab9b…dd61e
              </button>
              {' '}— it has hundreds of positions across the active set, gives you a feel for the scan output in ~1.5s.
            </div>
          )}

          {err && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 16, color: '#E05252', fontSize: 12 }}>
              {err}
            </div>
          )}

          {loading && (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              Scanning every validator ID in the registry — may take 5-10 seconds.
            </div>
          )}

          {data && !loading && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Positions</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--gold)' }}>{data.positionCount}</div>
                </div>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Total Delegated</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--gold)' }}>{fmt(data.totalStakeMon)} MON</div>
                </div>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Validators scanned</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--text)' }}>{data.validatorsScanned}</div>
                </div>
              </div>

              {data.positions.length === 0 ? (
                <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No delegations found for <span style={{ fontFamily: 'DM Mono, monospace', color: 'var(--text)' }}>{data.address}</span> across all {data.validatorsScanned} validator IDs in the active registry.
                </div>
              ) : (
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Validator</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>VID</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Your Stake</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>% of Total</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Commission</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positions.map(p => {
                        const pct = data.totalStakeMon > 0 ? (p.stakeMon / data.totalStakeMon) * 100 : 0;
                        return (
                          <tr key={p.validatorId} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px 12px' }}>
                              <Link href={`/validators/${p.authAddress}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                                {p.moniker || `${p.authAddress.slice(0, 8)}…${p.authAddress.slice(-4)}`}
                              </Link>
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>#{p.validatorId}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--gold)' }}>
                              {fmt(p.stakeMon)} MON
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>
                              {pct.toFixed(1)}%
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: (p.commissionPct ?? 0) > 10 ? '#E8A020' : 'var(--text)' }}>
                              {p.commissionPct != null ? `${p.commissionPct}%` : '—'}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: p.isActiveSet ? '#4CAF6E' : '#8A8870' }}>
                              {p.isActiveSet ? 'active' : 'inactive'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="card" style={{ padding: '14px 18px', marginTop: 16, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Stake values are read live from the Monad staking precompile (`getDelegator(validatorId, address)`). No reward-claim history here yet — coming in a later release.
                See <Link href="/delegate" style={{ color: 'var(--gold-dim)' }}>Delegate</Link> for picking a new validator,
                or <Link href={`/validators/${data.address}`} style={{ color: 'var(--gold-dim)' }}>your wallet&apos;s validator page</Link> if this address is also an operator auth.
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
