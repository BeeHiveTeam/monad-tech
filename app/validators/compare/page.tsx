'use client';
import { useState, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface Validator {
  address: string;
  moniker: string | null;
  blocksProduced: number;
  totalTxs: number;
  lastBlockNumber: number;
  lastBlockTs: number;
  sharePct: number;
  ageSeconds: number;
  participationPct: number | null;
  participationLong: number | null;
  cumulativeBlocks: number;
  cumulativeTxs: number;
  health: 'active' | 'slow' | 'missing';
  stakeMon: number | null;
  commissionPct: number | null;
  registered: boolean;
  isActiveSet: boolean;
}

interface ApiResponse {
  validators: Validator[];
  activeValidators: number;
  totalActiveStakeMon: number;
  aggregate?: { windowSec: number; totalBlocksObserved: number };
}

const HEALTH_COLOR: Record<Validator['health'], string> = {
  active: '#4CAF6E',
  slow: '#E8A020',
  missing: '#E05252',
};

function fmtMon(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—';
  return n.toFixed(digits) + '%';
}

function fmtAge(sec: number): string {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function shorten(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export default function CompareValidatorsPage() {
  return (
    <Suspense fallback={null}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [network, setNetwork] = useNetwork();
  const initialAddrs = useMemo(() => searchParams.getAll('addr').slice(0, 5), [searchParams]);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<string[]>(initialAddrs);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/validators?network=testnet', { cache: 'no-store' })
      .then(r => r.json() as Promise<ApiResponse>)
      .then(j => { if (!cancelled) { setData(j); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Find chosen validators (preserve order from `selected`)
  const chosen: Validator[] = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.validators.map(v => [v.address.toLowerCase(), v]));
    return selected
      .map(a => map.get(a.toLowerCase()))
      .filter((v): v is Validator => v != null);
  }, [data, selected]);

  // Search suggestions — when empty, show top validators by stake so users
  // landing here directly (no addresses preloaded) immediately see clickable
  // candidates instead of an empty box.
  const [searchFocused, setSearchFocused] = useState(false);
  const suggestions = useMemo(() => {
    if (!data) return [];
    const q = searchInput.trim().toLowerCase();
    if (!q) {
      // Empty input: show top by stake (only when search is focused)
      if (!searchFocused) return [];
      return [...data.validators]
        .filter(v => !selected.includes(v.address) && v.stakeMon != null)
        .sort((a, b) => (b.stakeMon ?? 0) - (a.stakeMon ?? 0))
        .slice(0, 8);
    }
    return data.validators
      .filter(v =>
        !selected.includes(v.address) &&
        ((v.moniker?.toLowerCase().includes(q)) || v.address.toLowerCase().includes(q))
      )
      .slice(0, 8);
  }, [data, searchInput, selected, searchFocused]);

  const updateUrl = (addrs: string[]) => {
    const params = new URLSearchParams();
    for (const a of addrs) params.append('addr', a);
    router.replace(`/validators/compare${params.toString() ? '?' + params.toString() : ''}`);
  };

  const addValidator = (addr: string) => {
    if (selected.length >= 5) return;
    if (selected.includes(addr)) return;
    const next = [...selected, addr];
    setSelected(next);
    setSearchInput('');
    updateUrl(next);
  };

  const removeValidator = (addr: string) => {
    const next = selected.filter(a => a !== addr);
    setSelected(next);
    updateUrl(next);
  };

  const copyShareLink = () => {
    if (typeof window !== 'undefined') {
      void navigator.clipboard.writeText(window.location.href);
    }
  };

  // Best-of indicators per row (highest stake, lowest commission, etc.)
  const winners = useMemo(() => {
    if (chosen.length < 2) return {};
    const w: Record<string, string> = {};
    const pick = (key: keyof Validator, mode: 'max' | 'min') => {
      let best: Validator | null = null;
      for (const v of chosen) {
        const val = v[key] as number | null;
        if (val == null) continue;
        if (!best) { best = v; continue; }
        const bestVal = best[key] as number;
        if (mode === 'max' ? val > bestVal : val < bestVal) best = v;
      }
      return best?.address ?? null;
    };
    w.stakeMon = pick('stakeMon', 'max') ?? '';
    w.commissionPct = pick('commissionPct', 'min') ?? '';
    w.participationLong = pick('participationLong', 'max') ?? '';
    w.cumulativeBlocks = pick('cumulativeBlocks', 'max') ?? '';
    return w;
  }, [chosen]);

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <HexBg />
      <SiteHeader network={network} onNetworkChange={setNetwork} />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 60px' }}>
        <TabNav />

        <div style={{
          marginTop: 16, marginBottom: 16,
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <h1 style={{
              margin: 0, fontFamily: 'Bebas Neue, sans-serif',
              fontSize: 32, letterSpacing: '0.05em', color: 'var(--gold)',
            }}>
              VALIDATOR COMPARISON
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              Side-by-side comparison for delegation decisions. Up to 5 validators.
            </p>
          </div>
          {selected.length > 0 && (
            <button
              onClick={copyShareLink}
              style={{
                padding: '6px 14px', fontFamily: 'DM Mono, monospace', fontSize: 11,
                background: 'transparent', color: 'var(--gold)',
                border: '1px solid var(--gold)', borderRadius: 4, cursor: 'pointer',
                letterSpacing: '0.06em',
              }}
            >COPY SHARE LINK</button>
          )}
        </div>

        {/* Search box */}
        <div className="card" style={{ padding: 16, marginBottom: 16, position: 'relative' }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              fontSize: 11, fontFamily: 'DM Mono, monospace', color: 'var(--text-muted)',
              letterSpacing: '0.06em',
            }}>
              ADD VALIDATOR ({selected.length}/5)
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
              placeholder="click here, then type moniker or pick from list…"
              disabled={selected.length >= 5}
              style={{
                flex: 1, minWidth: 200,
                padding: '6px 10px', fontFamily: 'DM Mono, monospace', fontSize: 12,
                background: 'var(--surface2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 4,
              }}
            />
          </div>
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', left: 16, right: 16, top: 50,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 4, zIndex: 20, maxHeight: 280, overflowY: 'auto',
            }}>
              {suggestions.map(v => (
                <button
                  key={v.address}
                  onClick={() => addValidator(v.address)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 12px', background: 'transparent', color: 'var(--text)',
                    border: 'none', borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', fontFamily: 'DM Mono, monospace', fontSize: 11,
                  }}
                >
                  <span style={{ color: 'var(--gold)' }}>{v.moniker ?? '—'}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{shorten(v.address)}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>· stake {fmtMon(v.stakeMon)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected chips */}
        {selected.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {chosen.map(v => (
              <div key={v.address} style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '4px 10px', background: 'rgba(201,168,76,0.08)',
                border: '1px solid rgba(201,168,76,0.3)', borderRadius: 4,
                fontFamily: 'DM Mono, monospace', fontSize: 11,
              }}>
                <span style={{ color: 'var(--gold)' }}>{v.moniker ?? shorten(v.address)}</span>
                <button onClick={() => removeValidator(v.address)} style={{
                  background: 'transparent', color: 'var(--text-muted)', border: 'none',
                  cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1,
                }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Comparison table */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading…
          </div>
        ) : chosen.length === 0 ? (
          <div className="card" style={{
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            <p style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text)' }}>
              Add 2-5 validators to compare side-by-side.
            </p>
            <p style={{ margin: '0 0 8px' }}>
              Click the search field above and pick from the list, or type a moniker (e.g. <code>BeeHive</code>) / paste an address.
            </p>
            <p style={{ margin: 0, fontSize: 12 }}>
              Tip: on the{' '}
              <a href="/validators" style={{ color: 'var(--gold)' }}>Validators</a>{' '}
              page you can tick checkboxes on multiple rows and click <strong>⇄ COMPARE</strong> to load them all here at once.
            </p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <colgroup>
                <col style={{ width: 180 }} />
                {chosen.map((_, i) => <col key={i} style={{ minWidth: 180 }} />)}
              </colgroup>
              <thead>
                <tr style={{ background: 'rgba(201,168,76,0.05)' }}>
                  <th style={thStyle}>METRIC</th>
                  {chosen.map(v => (
                    <th key={v.address} style={thStyle}>
                      <div style={{
                        fontFamily: 'Bebas Neue, sans-serif', fontSize: 16,
                        color: 'var(--gold)', letterSpacing: '0.04em', marginBottom: 2,
                      }}>
                        {v.moniker ?? shorten(v.address)}
                      </div>
                      <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 9, color: 'var(--text-muted)' }}>
                        {shorten(v.address)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <Row label="In active set" cells={chosen.map(v => v.isActiveSet ? '✓' : '—')} />
                <Row label="Registered" cells={chosen.map(v => v.registered ? '✓' : '—')} />
                <Row
                  label="Stake (MON)"
                  cells={chosen.map(v => ({ text: fmtMon(v.stakeMon), winner: v.address === winners.stakeMon }))}
                />
                <Row
                  label="Commission"
                  cells={chosen.map(v => ({ text: fmtPct(v.commissionPct, 2), winner: v.address === winners.commissionPct }))}
                />
                <Row
                  label="Health"
                  cells={chosen.map(v => ({
                    text: v.health.toUpperCase(),
                    color: HEALTH_COLOR[v.health],
                  }))}
                />
                <Row label="Last block age" cells={chosen.map(v => fmtAge(v.ageSeconds))} />
                <SectionHeader title="LIVE WINDOW (sample 500 blocks ≈ 200s)" />
                <Row label="Blocks (window)" cells={chosen.map(v => v.blocksProduced.toString())} />
                <Row label="Share %" cells={chosen.map(v => fmtPct(v.sharePct))} />
                <Row label="Participation %" cells={chosen.map(v => fmtPct(v.participationPct))} />
                <Row label="Total txs (window)" cells={chosen.map(v => v.totalTxs.toString())} />
                <SectionHeader title="LONG WINDOW (cumulative since process start)" />
                <Row
                  label="Cumulative blocks"
                  cells={chosen.map(v => ({ text: v.cumulativeBlocks.toString(), winner: v.address === winners.cumulativeBlocks }))}
                />
                <Row label="Cumulative txs" cells={chosen.map(v => v.cumulativeTxs.toString())} />
                <Row
                  label="Participation Long"
                  cells={chosen.map(v => ({
                    text: fmtPct(v.participationLong),
                    winner: v.address === winners.participationLong,
                  }))}
                />
              </tbody>
            </table>
          </div>
        )}

        {data?.aggregate && chosen.length > 0 && (
          <p style={{
            marginTop: 14, fontSize: 10, color: 'var(--text-muted)',
            lineHeight: 1.5, fontFamily: 'DM Mono, monospace',
          }}>
            Long-window data covers {Math.round(data.aggregate.windowSec / 60)} min
            ({data.aggregate.totalBlocksObserved.toLocaleString()} blocks observed since process start).
            <br />
            <strong>How to read:</strong> ★ marks the best value among compared validators.
            Participation Long is stake-weighted — 100% means producing exactly the fair share
            given stake. Higher = over-producing, lower = under-producing.
          </p>
        )}
      </main>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px 14px',
  fontFamily: 'DM Mono, monospace',
  fontSize: 10,
  fontWeight: 'normal',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--border)',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 14px',
  fontFamily: 'DM Mono, monospace',
  fontSize: 12,
  color: 'var(--text)',
  borderBottom: '1px solid rgba(201,168,76,0.08)',
};

const labelStyle: React.CSSProperties = {
  ...tdStyle,
  fontSize: 10,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
};

type CellInput = string | { text: string; winner?: boolean; color?: string };

function Row({ label, cells }: { label: string; cells: CellInput[] }) {
  return (
    <tr>
      <td style={labelStyle}>{label}</td>
      {cells.map((c, i) => {
        const isObj = typeof c === 'object';
        const text = isObj ? c.text : c;
        const winner = isObj && c.winner;
        const color = isObj ? c.color : undefined;
        return (
          <td key={i} style={{
            ...tdStyle,
            color: color ?? (winner ? 'var(--gold)' : tdStyle.color),
            fontWeight: winner ? 600 : 400,
          }}>
            {text}{winner ? ' ★' : ''}
          </td>
        );
      })}
    </tr>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <tr>
      <td colSpan={6} style={{
        padding: '14px 14px 6px',
        fontFamily: 'Bebas Neue, sans-serif', fontSize: 12,
        letterSpacing: '0.1em', color: 'var(--gold)',
        borderTop: '1px solid var(--border)',
      }}>
        {title}
      </td>
    </tr>
  );
}
