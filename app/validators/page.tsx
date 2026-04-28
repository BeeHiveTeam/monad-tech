'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import Pagination from '@/components/Pagination';
import { NETWORKS } from '@/lib/networks';
import { useNetwork } from '@/lib/useNetwork';

type Health = 'active' | 'slow' | 'missing';
type SortKey = 'score' | 'rank' | 'health' | 'uptime' | 'blocks' | 'share' | 'txs' | 'age' | 'stake' | 'commission';

interface Validator {
  address: string;
  moniker: string | null;
  blocksProduced: number;
  totalTxs: number;
  lastBlockNumber: number;
  lastBlockTs: number;
  sharePct: number;
  ageSeconds: number;
  participationPct: number;
  health: Health;
  stakeMon?: number;
  commissionPct?: number;
  registered?: boolean;
}

interface ValidatorsData {
  sampleSize: number;
  totalValidators: number;
  windowSeconds: number;
  expectedGapSeconds: number;
  updatedAt: number;
  validators: Validator[];
  stale?: boolean;
  ageSeconds?: number;
  building?: boolean;
  message?: string;
}

const HEALTH_ORDER: Record<Health, number> = { active: 0, slow: 1, missing: 2 };
const HEALTH_STYLE: Record<Health, { bg: string; fg: string; label: string }> = {
  active:  { bg: 'rgba(76,175,110,0.14)', fg: '#4CAF6E', label: 'ACTIVE' },
  slow:    { bg: 'rgba(201,168,76,0.14)', fg: '#C9A84C', label: 'SLOW' },
  missing: { bg: 'rgba(224,82,82,0.14)',  fg: '#E05252', label: 'MISSING' },
};

const POLL_INTERVAL = 30_000;
const POLL_INTERVAL_BUILDING = 15_000;

const COL_KEYS = [
  'num', 'moniker', 'address', 'stake', 'commission', 'score',
  'health', 'uptime', 'blocks', 'share', 'txs', 'lastBlock',
] as const;
type ColKey = typeof COL_KEYS[number];

// Widths tuned so typical content fits without overflow.
//   stake/commission/uptime/share — small numeric; give enough for "100.0%" etc.
//   score — 3-digit number, small
//   moniker — most monikers are 10-22 chars; gives 200px
//   address — 0xabcd…1234 at 12px mono ≈ 140px
//   blocks/txs — 5-digit numbers
//   lastBlock — "5m" / "12h" / "3d" — small
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  num: 48, moniker: 200, address: 150, stake: 100, commission: 90,
  score: 80, health: 110, uptime: 90, blocks: 90, share: 80, txs: 100, lastBlock: 96,
};
// Bumped v1 → v2: widths changed; drop any stored v1 values.
const WIDTHS_STORAGE_KEY = 'monad-stats:validator-col-widths:v2';
const MIN_COL_WIDTH = 40;

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function calcScore(v: Validator, expectedGapSeconds: number): number {
  const healthScore = v.health === 'active' ? 100 : v.health === 'slow' ? 40 : 0;
  const uptimeScore = Math.min(v.participationPct, 100);
  const maxAge = expectedGapSeconds * 5;
  const recencyScore = maxAge > 0 ? Math.max(0, (1 - v.ageSeconds / maxAge)) * 100 : 0;
  const base = healthScore * 0.4 + uptimeScore * 0.4 + recencyScore * 0.2;
  // Unregistered block producers (miner addr not in staking precompile) get a
  // 0.7× penalty. Block production is verified, but stake backing isn't —
  // without that we can't tell if they'll stay honest or are a throwaway key.
  const penalty = v.registered === false ? 0.7 : 1;
  return Math.round(base * penalty);
}

function scoreColor(score: number): string {
  if (score >= 75) return '#4CAF6E';
  if (score >= 45) return '#C9A84C';
  return '#E05252';
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span style={{ marginLeft: 4, opacity: active ? 1 : 0.3, fontSize: 10 }}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );
}

export default function ValidatorsPage() {
  const router = useRouter();
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<ValidatorsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  // Consecutive-failure counter for live-state tolerance (see page.tsx comment).
  const [failCount, setFailCount] = useState(0);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [widths, setWidths] = useState<Record<ColKey, number>>(DEFAULT_WIDTHS);
  const [resizing, setResizing] = useState<ColKey | null>(null);
  const [page, setPage] = useState(1);
  const [hideUnregistered, setHideUnregistered] = useState(false);
  const PAGE_SIZE = 20;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore saved widths from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WIDTHS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<ColKey, number>>;
        setWidths(prev => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore parse errors — fall back to defaults
    }
  }, []);

  const startResize = useCallback((key: ColKey) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
    setResizing(key);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX)));
      setWidths(prev => (prev[key] === next ? prev : { ...prev, [key]: next }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(null);
      setWidths(curr => {
        try { localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(curr)); } catch { /* full disk etc. */ }
        return curr;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [widths]);

  const resetWidths = useCallback(() => {
    setWidths(DEFAULT_WIDTHS);
    try { localStorage.removeItem(WIDTHS_STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/validators?network=${network}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastUpdate(new Date());
      setError(null);
      setFailCount(0);
    } catch (e) {
      setError(String(e));
      setFailCount(c => c + 1);
    } finally {
      setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchData();
    if (timerRef.current) clearInterval(timerRef.current);
    const interval = data?.building ? POLL_INTERVAL_BUILDING : POLL_INTERVAL;
    timerRef.current = setInterval(fetchData, interval);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchData, network, data?.building]);

  function handleSort(key: SortKey) {
    setPage(1);
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  // Reset to page 1 whenever the filter changes so we don't show empty pages.
  useEffect(() => { setPage(1); }, [search]);

  const processed = useMemo(() => {
    if (!data?.validators) return [];
    const exp = data.expectedGapSeconds || 1;

    const withScore = data.validators.map(v => ({
      ...v,
      score: calcScore(v, exp),
    }));

    const q = search.trim().toLowerCase();
    let filtered = q
      ? withScore.filter(v =>
          v.address.toLowerCase().includes(q) ||
          (v.moniker ?? '').toLowerCase().includes(q)
        )
      : withScore;
    if (hideUnregistered) filtered = filtered.filter(v => v.registered !== false);

    return [...filtered].sort((a, b) => {
      let diff = 0;
      switch (sortKey) {
        case 'score':   diff = a.score - b.score; break;
        case 'rank':    diff = b.blocksProduced - a.blocksProduced; break; // original rank
        case 'health':  diff = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health]; break;
        case 'uptime':  diff = a.participationPct - b.participationPct; break;
        case 'blocks':  diff = a.blocksProduced - b.blocksProduced; break;
        case 'share':   diff = a.sharePct - b.sharePct; break;
        case 'txs':        diff = a.totalTxs - b.totalTxs; break;
        case 'age':        diff = b.ageSeconds - a.ageSeconds; break;
        case 'stake':      diff = (a.stakeMon ?? 0) - (b.stakeMon ?? 0); break;
        case 'commission': diff = (a.commissionPct ?? 0) - (b.commissionPct ?? 0); break;
      }
      if (diff === 0) {
        // Tiebreak: registered wins over unregistered, so known validators
        // bubble up when scores tie.
        const aReg = a.registered !== false ? 1 : 0;
        const bReg = b.registered !== false ? 1 : 0;
        diff = aReg - bReg;
      }
      return sortDir === 'desc' ? -diff : diff;
    });
  }, [data, search, sortKey, sortDir, hideUnregistered]);

  const explorer = NETWORKS[network].explorer;
  // Tolerant of single transient failures — same pattern as home page.
  const timeSinceUpdate = lastUpdate ? Date.now() - lastUpdate.getTime() : Infinity;
  const liveState: 'live' | 'loading' | 'offline' =
    !data && loading ? 'loading' :
    failCount >= 3 || timeSinceUpdate > 60_000 ? 'offline' :
    'live';

  const RIGHT_ALIGN: SortKey[] = ['score', 'uptime', 'blocks', 'share', 'txs', 'stake', 'commission', 'age'];
  const thStyle = (key: SortKey): React.CSSProperties => ({
    textAlign: key === 'health' ? 'center' : RIGHT_ALIGN.includes(key) ? 'right' : 'left',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    userSelect: 'none',
    color: sortKey === key ? 'var(--gold)' : 'var(--text-muted)',
    transition: 'color 0.15s',
  });

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader
          network={network}
          onNetworkChange={setNetwork}
          liveState={liveState}
          lastUpdate={lastUpdate}
        />

        <main className="site-main">
          <TabNav />

          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="badge-gold">{NETWORKS[network].name}</span>
            {data && !data.building && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Sampled last {data.sampleSize.toLocaleString('en-US')} blocks · {data.totalValidators} validators
              </span>
            )}
            {data?.stale && data.ageSeconds !== undefined && (
              <span style={{
                fontSize: 11, padding: '3px 9px', borderRadius: 4,
                background: 'rgba(201,168,76,0.1)', color: 'var(--gold-dim)',
                border: '1px solid rgba(201,168,76,0.25)', letterSpacing: '0.05em',
              }}>
                cached {Math.floor(data.ageSeconds / 60)}m {data.ageSeconds % 60}s · refreshing…
              </span>
            )}
            {error && <span className="badge-red">Error — {error.slice(0, 60)}</span>}
          </div>

          <div className="card" style={{ padding: '24px' }}>
            {/* Header — title row + controls row. Kept as two visual tiers so the
                big Bebas Neue count doesn't share baseline with tiny mono chips. */}
            <div style={{
              marginBottom: 16, paddingBottom: 12,
              borderBottom: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {/* Tier 1: title + cadence */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <span style={{
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 18,
                  letterSpacing: '0.08em', color: 'var(--gold)',
                }}>
                  Active Validators
                </span>
                <span style={{
                  fontFamily: 'DM Mono, monospace', fontSize: 12,
                  color: 'var(--text)',
                }}>
                  {processed.length}{search ? ` / ${data?.validators.length ?? 0}` : ''}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  · updates every {POLL_INTERVAL / 1000}s
                </span>
              </div>

              {/* Tier 2: controls — toggles on left, search on right */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                justifyContent: 'space-between', flexWrap: 'wrap',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setHideUnregistered(!hideUnregistered)}
                    title="Hide block producers whose miner address isn't in the staking precompile (separate signing key → stake info unavailable)"
                    style={{
                      height: 28, padding: '0 12px',
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 10, letterSpacing: '0.08em',
                      background: hideUnregistered ? 'rgba(201,168,76,0.15)' : 'transparent',
                      color: hideUnregistered ? 'var(--gold)' : 'var(--text-muted)',
                      border: `1px solid ${hideUnregistered ? 'var(--gold)' : 'var(--border)'}`,
                      borderRadius: 6, cursor: 'pointer',
                      fontFamily: 'DM Mono, monospace', userSelect: 'none',
                      transition: 'all 0.15s',
                    }}
                  >
                    <span style={{
                      display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                      border: `1px solid ${hideUnregistered ? 'var(--gold)' : 'var(--text-muted)'}`,
                      background: hideUnregistered ? 'var(--gold)' : 'transparent',
                      position: 'relative',
                    }}>
                      {hideUnregistered && (
                        <span style={{
                          position: 'absolute', top: -2, left: 1, fontSize: 10,
                          lineHeight: 1, color: '#080808', fontWeight: 700,
                        }}>✓</span>
                      )}
                    </span>
                    REGISTERED ONLY
                  </button>
                  <button
                    onClick={resetWidths}
                    title="Reset column widths"
                    style={{
                      height: 28, padding: '0 10px',
                      fontSize: 10, letterSpacing: '0.08em',
                      background: 'transparent', color: 'var(--text-muted)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      cursor: 'pointer', fontFamily: 'DM Mono, monospace',
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                  >
                    ↔ RESET COLUMNS
                  </button>
                  <button
                    onClick={() => router.push('/validators/compare')}
                    title="Compare 2-5 validators side-by-side"
                    style={{
                      height: 28, padding: '0 12px',
                      fontSize: 10, letterSpacing: '0.08em',
                      background: 'transparent', color: 'var(--gold)',
                      border: '1px solid var(--gold)', borderRadius: 6,
                      cursor: 'pointer', fontFamily: 'DM Mono, monospace',
                    }}
                  >
                    ⇄ COMPARE
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="Search moniker or address…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    height: 28, boxSizing: 'border-box',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '0 12px',
                    fontSize: 12,
                    color: 'var(--text)',
                    outline: 'none',
                    minWidth: 220,
                    fontFamily: 'DM Mono, monospace',
                    transition: 'border-color 0.15s',
                  }}
                  onFocus={e => (e.target.style.borderColor = 'var(--gold)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                />
              </div>
            </div>

            {(loading && !data) || data?.building ? (
              <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {data?.message ?? 'Collecting validator data…'}
                <div style={{ marginTop: 10, fontSize: 11, color: 'rgba(138,136,112,0.6)' }}>
                  Автообновление каждые {POLL_INTERVAL_BUILDING / 1000}с до готовности
                </div>
              </div>
            ) : !data || processed.length === 0 ? (
              <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {search ? `No validators match "${search}"` : 'No validator data available'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table
                  className="resizable-table"
                  style={{ width: Object.values(widths).reduce((a, b) => a + b, 0) }}
                >
                  <colgroup>
                    {COL_KEYS.map(k => <col key={k} style={{ width: widths[k] }} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        #
                        <ResizeHandle colKey="num" onMouseDown={startResize('num')} active={resizing === 'num'} />
                      </th>
                      <th style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        Moniker
                        <ResizeHandle colKey="moniker" onMouseDown={startResize('moniker')} active={resizing === 'moniker'} />
                      </th>
                      <th style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        Address
                        <ResizeHandle colKey="address" onMouseDown={startResize('address')} active={resizing === 'address'} />
                      </th>
                      <th style={thStyle('stake')} onClick={() => handleSort('stake')}>
                        Stake <SortIcon active={sortKey === 'stake'} dir={sortDir} />
                        <ResizeHandle colKey="stake" onMouseDown={startResize('stake')} active={resizing === 'stake'} />
                      </th>
                      <th style={thStyle('commission')} onClick={() => handleSort('commission')}>
                        Comm. <SortIcon active={sortKey === 'commission'} dir={sortDir} />
                        <ResizeHandle colKey="commission" onMouseDown={startResize('commission')} active={resizing === 'commission'} />
                      </th>
                      <th style={thStyle('score')} onClick={() => handleSort('score')}>
                        Score <SortIcon active={sortKey === 'score'} dir={sortDir} />
                        <ResizeHandle colKey="score" onMouseDown={startResize('score')} active={resizing === 'score'} />
                      </th>
                      <th style={thStyle('health')} onClick={() => handleSort('health')}>
                        Health <SortIcon active={sortKey === 'health'} dir={sortDir} />
                        <ResizeHandle colKey="health" onMouseDown={startResize('health')} active={resizing === 'health'} />
                      </th>
                      <th style={thStyle('uptime')} onClick={() => handleSort('uptime')}>
                        Uptime <SortIcon active={sortKey === 'uptime'} dir={sortDir} />
                        <ResizeHandle colKey="uptime" onMouseDown={startResize('uptime')} active={resizing === 'uptime'} />
                      </th>
                      <th style={thStyle('blocks')} onClick={() => handleSort('blocks')}>
                        Blocks <SortIcon active={sortKey === 'blocks'} dir={sortDir} />
                        <ResizeHandle colKey="blocks" onMouseDown={startResize('blocks')} active={resizing === 'blocks'} />
                      </th>
                      <th style={thStyle('share')} onClick={() => handleSort('share')}>
                        Share <SortIcon active={sortKey === 'share'} dir={sortDir} />
                        <ResizeHandle colKey="share" onMouseDown={startResize('share')} active={resizing === 'share'} />
                      </th>
                      <th style={thStyle('txs')} onClick={() => handleSort('txs')}>
                        Txs <SortIcon active={sortKey === 'txs'} dir={sortDir} />
                        <ResizeHandle colKey="txs" onMouseDown={startResize('txs')} active={resizing === 'txs'} />
                      </th>
                      <th style={thStyle('age')} onClick={() => handleSort('age')}>
                        Last Block <SortIcon active={sortKey === 'age'} dir={sortDir} />
                        <ResizeHandle colKey="lastBlock" onMouseDown={startResize('lastBlock')} active={resizing === 'lastBlock'} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {processed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((v, idx) => {
                      const i = (page - 1) * PAGE_SIZE + idx;   // absolute rank across pages
                      const hs = HEALTH_STYLE[v.health];
                      const uptimeDisplay = Math.min(v.participationPct, 100);
                      const uptimeColor =
                        uptimeDisplay < 50 ? '#E05252' :
                        uptimeDisplay < 80 ? '#C9A84C' : '#4CAF6E';
                      const sc = v.score;
                      const scColor = scoreColor(sc);
                      return (
                        <tr key={v.address}
                          onClick={() => router.push(`/validators/${v.address}`)}
                          style={{ cursor: 'pointer' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.06)')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}
                        >
                          <td style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {i + 1}
                          </td>
                          <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {v.moniker ? (
                              <span
                                title={v.moniker}
                                style={{ color: 'var(--gold)', fontWeight: 500 }}
                              >
                                {v.moniker}
                              </span>
                            ) : v.registered === false ? (
                              <span
                                title="Block producer not matched to on-chain staking registry. Likely uses a separate signing key from its authAddress. Stake info is unavailable — treat score with caution."
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 6,
                                  color: '#E8A020', fontSize: 12, fontStyle: 'italic',
                                }}
                              >
                                <span style={{ fontSize: 11 }}>⚠</span>
                                unregistered signer
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>
                                unknown
                              </span>
                            )}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <a
                              href={`${explorer}/address/${v.address}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              style={{ color: 'var(--text)', fontFamily: 'DM Mono, monospace', fontSize: 12, textDecoration: 'none' }}
                            >
                              {shortAddr(v.address)}
                            </a>
                          </td>
                          {/* Stake */}
                          <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {v.stakeMon != null
                              ? <span style={{ color: 'var(--gold)' }}>{(v.stakeMon / 1_000_000).toFixed(1)}M</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          {/* Commission */}
                          <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {v.commissionPct != null
                              ? <span style={{ color: v.commissionPct > 10 ? '#E8A020' : 'var(--text)' }}>{v.commissionPct.toFixed(0)}%</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          {/* Score */}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <span
                              title={`Health ${v.health} · Uptime ${Math.min(v.participationPct, 100).toFixed(0)}%`}
                              style={{
                                fontFamily: 'Bebas Neue, sans-serif', fontSize: 16,
                                color: scColor, letterSpacing: '0.04em',
                              }}
                            >
                              {sc}
                            </span>
                          </td>
                          {/* Health */}
                          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                            <span
                              title={`Last block ${v.ageSeconds}s ago`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                padding: '3px 10px', borderRadius: 12,
                                background: hs.bg, color: hs.fg,
                                fontSize: 10, letterSpacing: '0.08em', fontWeight: 500,
                                border: `1px solid ${hs.fg}33`,
                              }}
                            >
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: hs.fg }} />
                              {hs.label}
                            </span>
                          </td>
                          {/* Uptime */}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <span
                              title={v.participationPct > 100 ? `raw ${v.participationPct.toFixed(0)}% (high stake)` : undefined}
                              style={{ fontSize: 12, color: uptimeColor, fontFamily: 'DM Mono, monospace' }}
                            >
                              {uptimeDisplay.toFixed(0)}%
                            </span>
                          </td>
                          {/* Blocks */}
                          <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 13, whiteSpace: 'nowrap' }}>
                            {v.blocksProduced.toLocaleString('en-US')}
                          </td>
                          {/* Share */}
                          <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {v.sharePct.toFixed(1)}%
                          </td>
                          {/* Txs */}
                          <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {v.totalTxs.toLocaleString('en-US')}
                          </td>
                          {/* Last Block */}
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                            {v.lastBlockTs
                              ? <span title={new Date(v.lastBlockTs * 1000).toLocaleString()}>{shortAge(v.ageSeconds)}</span>
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {processed.length > PAGE_SIZE && (
                  <div style={{ marginTop: 8 }}>
                    <Pagination
                      currentPage={page}
                      totalPages={Math.max(1, Math.ceil(processed.length / PAGE_SIZE))}
                      onPageChange={setPage}
                    />
                    <div style={{
                      textAlign: 'center', marginTop: 6, fontSize: 10,
                      color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace',
                    }}>
                      showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, processed.length)} of {processed.length}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              <div style={{ marginBottom: 6 }}>
                <b style={{ color: 'var(--text)' }}>Score</b> — рейтинг 0–100:
                Health (40%) + Uptime (40%) + Recency (20%).{' '}
                <span style={{ color: '#4CAF6E' }}>≥75</span> отлично,{' '}
                <span style={{ color: '#C9A84C' }}>45–74</span> норма,{' '}
                <span style={{ color: '#E05252' }}>&lt;45</span> проблема.
              </div>
              <div style={{ marginBottom: 6 }}>
                <b style={{ color: 'var(--text)' }}>Health</b> — время с последнего блока.{' '}
                <span style={{ color: '#4CAF6E' }}>ACTIVE</span> = недавно лидировал,{' '}
                <span style={{ color: '#C9A84C' }}>SLOW</span> = задержка 2–5× от среднего,{' '}
                <span style={{ color: '#E05252' }}>MISSING</span> = не видно &gt;5×.
                {data && <> Средний интервал: ~{data.expectedGapSeconds}s.</>}
              </div>
              <div style={{ marginBottom: 6 }}>
                <b style={{ color: 'var(--text)' }}>Uptime</b> — произведённые блоки ÷ ожидаемые (равный стейк). 100% = норма.
              </div>
              <div>
                Данные из поля <code style={{ color: 'var(--gold-dim)' }}>miner</code> последних {data?.sampleSize ?? 0} блоков.
                Monad public RPC не отдаёт голоса/пиры — метрики только по лидирующим блокам.
              </div>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginTop: 40, paddingBottom: 32, color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em' }}>
            <a href="https://bee-hive.work" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>BeeHive</a>
            {' '}·{' '}Monad Network Monitor
          </div>
        </main>
      </div>
    </>
  );
}

function ResizeHandle({
  onMouseDown, active,
}: {
  colKey: ColKey;
  onMouseDown: (e: React.MouseEvent) => void;
  active: boolean;
}) {
  return (
    <span
      className={`col-resize${active ? ' active' : ''}`}
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      aria-hidden
    />
  );
}
