'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

type Health = 'active' | 'slow' | 'missing';

interface V {
  address: string;
  moniker: string | null;
  stakeMon?: number;
  commissionPct?: number;
  aprDelegator?: number | null;
  aprGross?: number | null;
  participationLong?: number | null;
  participationPct: number;
  health: Health;
  isActiveSet?: boolean;
  validatorIds?: number[];
}

interface Resp {
  validators: V[];
  totalActiveStakeMon?: number;
  building?: boolean;
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Delegator-facing composite for picking a validator. Different from the
 * operator-side "Composite Score" (which weights ops maturity, info polish).
 * For delegators what matters is realized yield + how reliable + how much
 * you contribute to decentralization (penalty if you stack a whale).
 *
 *   pick = aprDelegator × healthFactor × decentralizationBonus
 *
 *   healthFactor:
 *     active + participationLong ≥ 90% → 1.00
 *     slow OR participation 70-90%     → 0.80
 *     missing OR participation < 70%   → 0.30
 *
 *   decentralizationBonus:
 *     sharePct < 0.5%  → 1.10 (rewarded for choosing small operator)
 *     0.5% ≤ < 2%      → 1.00 (neutral)
 *     2% ≤ < 5%        → 0.85
 *     ≥ 5%             → 0.60 (whale, penalised)
 */
function pickScore(v: V, totalStake: number): number {
  if (!v.aprDelegator || !v.isActiveSet) return 0;
  const part = v.participationLong ?? v.participationPct ?? 100;
  const healthFactor =
    v.health === 'active' && part >= 90 ? 1.0 :
    v.health === 'missing' || part < 70 ? 0.3 :
    0.8;
  const share = totalStake > 0 ? (v.stakeMon ?? 0) / totalStake * 100 : 0;
  const decFactor =
    share < 0.5 ? 1.10 :
    share < 2   ? 1.00 :
    share < 5   ? 0.85 : 0.60;
  return v.aprDelegator * healthFactor * decFactor;
}

export default function DelegatePage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [maxCommission, setMaxCommission] = useState(15);
  const [minStake, setMinStake] = useState(0);
  const [hideTop10, setHideTop10] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/validators?network=${network}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(r => r.json())
      .then((d: Resp) => { setData(d); setLoading(false); })
      .catch(e => { if (e?.name !== 'AbortError') setLoading(false); });
    return () => ctrl.abort();
  }, [network]);

  const ranked = useMemo(() => {
    if (!data?.validators) return [];
    const total = data.totalActiveStakeMon ?? data.validators.reduce((s, v) => s + (v.stakeMon ?? 0), 0);
    const eligible = data.validators
      .filter(v => v.isActiveSet)
      .filter(v => (v.commissionPct ?? 100) <= maxCommission)
      .filter(v => (v.stakeMon ?? 0) >= minStake)
      .map(v => ({ v, score: pickScore(v, total), share: total > 0 ? (v.stakeMon ?? 0) / total * 100 : 0 }))
      .filter(({ share }) => !hideTop10 || share < 5);
    eligible.sort((a, b) => b.score - a.score);
    return eligible.slice(0, 50);
  }, [data, maxCommission, minStake, hideTop10]);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={loading ? 'loading' : 'live'} lastUpdate={null} />
        <main className="site-main">
          <TabNav />

          <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.06em', margin: 0, fontWeight: 400 }}>
              Pick a validator for your delegation
            </h1>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, maxWidth: 760, lineHeight: 1.5 }}>
              Ranked by a delegator-facing composite: <strong>net APR × health-factor × decentralization-bonus</strong>.
              Small operators get a +10% bonus; whales (≥5% stake share) lose 40%. Hides validators with high commission, low stake, or non-active status by default.
              Tweak the filters below.
            </div>
          </div>

          <div className="card" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Max commission</span>
              <select value={maxCommission} onChange={e => setMaxCommission(Number(e.target.value))}
                style={{ background: 'transparent', color: 'var(--gold)', border: '1px solid var(--gold-dim)', padding: '4px 8px', borderRadius: 3 }}>
                <option value={5}>5%</option>
                <option value={10}>10%</option>
                <option value={15}>15% (VDP cap)</option>
                <option value={100}>any</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Min stake</span>
              <select value={minStake} onChange={e => setMinStake(Number(e.target.value))}
                style={{ background: 'transparent', color: 'var(--gold)', border: '1px solid var(--gold-dim)', padding: '4px 8px', borderRadius: 3 }}>
                <option value={0}>any</option>
                <option value={1_000_000}>1M MON</option>
                <option value={10_000_000}>10M MON (Tier-4)</option>
                <option value={25_000_000}>25M MON (Tier-4 self-stake)</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={hideTop10} onChange={e => setHideTop10(e.target.checked)} />
              <span style={{ color: 'var(--text-muted)' }}>Hide whales (≥5% stake)</span>
            </label>
            <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
              {loading ? 'loading…' : `${ranked.length} matches`}
            </div>
          </div>

          {loading ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading validator data…
            </div>
          ) : ranked.length === 0 ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              No validators match these filters. Loosen the constraints (raise max commission, drop min stake, allow whales).
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>#</th>
                    <th style={{ padding: '10px 12px', textAlign: 'left',  color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Validator</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stake</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Share</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Comm.</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>APR (net)</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Uptime</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Pick</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map(({ v, score, share }, i) => {
                    const up = v.participationLong ?? v.participationPct ?? 100;
                    return (
                      <tr key={v.address} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)' }}>{i + 1}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <Link href={`/validators/${v.address}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                            {v.moniker ?? shortAddr(v.address)}
                          </Link>
                          {v.validatorIds && v.validatorIds.length > 1 && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                              ({v.validatorIds.length} IDs)
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>
                          {v.stakeMon ? `${(v.stakeMon / 1_000_000).toFixed(1)}M` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: share >= 5 ? '#E05252' : share >= 2 ? '#E8A020' : 'var(--text-muted)' }}>
                          {share.toFixed(2)}%
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: (v.commissionPct ?? 0) > 10 ? '#E8A020' : 'var(--text)' }}>
                          {v.commissionPct != null ? `${v.commissionPct}%` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: 'var(--gold)' }}>
                          {v.aprDelegator != null ? `${v.aprDelegator.toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: up >= 90 ? '#4CAF6E' : up >= 70 ? '#E8A020' : '#E05252' }}>
                          {Math.min(up, 100).toFixed(0)}%
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color: 'var(--gold)' }}>
                          {score.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ padding: '14px 18px', marginTop: 16, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <strong>How &ldquo;Pick&rdquo; is computed:</strong> net APR × health-factor × decentralization-bonus.
            Net APR is realized block-reward yield against stake, after commission. Health-factor penalises slow or missing validators.
            Decentralization-bonus rewards picking smaller operators — choosing a whale shifts BFT power further to them.
            See <Link href="/network/concentration" style={{ color: 'var(--gold-dim)' }}>concentration deep-dive</Link> for why this matters,
            and <Link href="/validators" style={{ color: 'var(--gold-dim)' }}>the full validators table</Link> for unfiltered raw data.
          </div>
        </main>
      </div>
    </>
  );
}
