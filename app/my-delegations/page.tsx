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
  validatorsTotal: number;
  validatorsFailed: number;
  complete: boolean;
  partial: boolean;
  registryStale?: boolean;
  message?: string;
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
  const [scanNumber, setScanNumber] = useState(0);
  const [building, setBuilding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!submitted) return;
    const ctrl = new AbortController();
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setLoading(true);
    setBuilding(false);
    setErr(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/my-delegations?address=${submitted}&network=${network}`, {
          signal: ctrl.signal, cache: 'no-store',
        });
        const result: Resp = await response.json();
        if (cancelled) return;
        if (result.error || !response.ok) {
          setErr(result.error || 'Unable to verify delegations. Please retry.');
          setLoading(false);
          setBuilding(false);
          return;
        }
        if (result.network !== network || result.address?.toLowerCase() !== submitted) {
          throw new Error('The scan returned a different wallet or network. Please retry.');
        }
        if (result.building) {
          setBuilding(true);
          setLoading(true);
          retry = setTimeout(load, 5_000);
          return;
        }
        setData(result);
        setNow(Date.now());
        setBuilding(false);
        setLoading(false);
      } catch (error) {
        if (!cancelled && !ctrl.signal.aborted) {
          setErr(error instanceof Error ? error.message : 'Unable to verify delegations. Please retry.');
          setLoading(false);
          setBuilding(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      ctrl.abort();
      if (retry) clearTimeout(retry);
    };
  }, [submitted, network, scanNumber]);

  // Do not flash the previous wallet/network's result before the effect runs.
  const resultMatches = data?.network === network && data.address.toLowerCase() === submitted;
  const visibleData = resultMatches ? data : null;
  const stale = !!visibleData && (!Number.isFinite(visibleData.fetchedAt) || now - visibleData.fetchedAt > 60_000);
  const liveState = loading ? 'loading'
    : err || building || !visibleData?.complete || visibleData.partial || stale ? 'offline' : 'live';

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
    setScanNumber(n => n + 1);
    setLoading(true);
    setBuilding(false);
  };

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={liveState} lastUpdate={visibleData ? new Date(visibleData.fetchedAt) : null} />
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
            <div role="alert" className="card" style={{ padding: '12px 16px', marginBottom: 16, color: '#E05252', fontSize: 12 }}>
              {err}
            </div>
          )}

          {loading && (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {building ? 'Validator registry is loading. Retrying automatically…' : 'Verifying balances across the validator registry…'}
            </div>
          )}

          {visibleData && !loading && !err && (
            <>
              {(!visibleData.complete || visibleData.partial) && (
                <div className="card" role="status" style={{ padding: '12px 16px', marginBottom: 16, color: '#E8A020', fontSize: 12 }}>
                  Partial scan: verified {visibleData.validatorsScanned} of {visibleData.validatorsTotal} known validator IDs.
                  {' '}{visibleData.validatorsFailed} balance reads failed or were not completed.
                  {visibleData.registryStale && ' Validator registry data is stale.'}
                  {' '}Balances below are confirmed observations, not your complete portfolio. Retry the scan.
                </div>
              )}
              {stale && (
                <div className="card" role="status" style={{ padding: '12px 16px', marginBottom: 16, color: '#E8A020', fontSize: 12 }}>
                  This scan is over a minute old. Scan again to refresh balances.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Positions</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--gold)' }}>{visibleData.positionCount}</div>
                </div>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>{visibleData.complete ? 'Total Delegated' : 'Verified Delegated (partial)'}</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--gold)' }}>{fmt(visibleData.totalStakeMon)} MON</div>
                </div>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Validators scanned</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 26, color: 'var(--text)' }}>{visibleData.validatorsScanned} / {visibleData.validatorsTotal}</div>
                </div>
              </div>

              {visibleData.positions.length === 0 ? (
                <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                  {visibleData.complete ? 'No delegations found for ' : 'No non-zero delegations verified for '}<span style={{ fontFamily: 'DM Mono, monospace', color: 'var(--text)' }}>{visibleData.address}</span> across {visibleData.validatorsScanned} successfully checked validator IDs{visibleData.complete ? ' in the registry.' : '. The scan is incomplete; other positions may exist.'}
                </div>
              ) : (
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Validator</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>VID</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Your Stake</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{visibleData.complete ? '% of Total' : '% of Verified'}</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Commission</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleData.positions.map(p => {
                        const pct = visibleData.totalStakeMon > 0 ? (p.stakeMon / visibleData.totalStakeMon) * 100 : 0;
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
                or <Link href={`/validators/${visibleData.address}`} style={{ color: 'var(--gold-dim)' }}>your wallet&apos;s validator page</Link> if this address is also an operator auth.
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
