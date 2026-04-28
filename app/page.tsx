'use client';
// NB: `export const dynamic = 'force-dynamic'` doesn't work from a 'use client'
// file — Next.js needs a server component for that. Instead we make the SSR
// fallback non-alarming (amber "congested" instead of red "offline") so the
// cached prerender doesn't scream OFFLINE for 200-1000ms before hydration.
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import StatCard from '@/components/StatCard';
import BlocksTable from '@/components/BlocksTable';
import TxTable from '@/components/TxTable';
import Pagination from '@/components/Pagination';
import TxSearch from '@/components/TxSearch';
import HealthBadge from '@/components/HealthBadge';
import EpochCard from '@/components/EpochCard';
import NetworkHealthCard from '@/components/NetworkHealthCard';
import ParallelismPanel from '@/components/ParallelismPanel';
import TopContractsTable from '@/components/TopContractsTable';
import { NETWORKS } from '@/lib/networks';
import { useNetwork } from '@/lib/useNetwork';

type ChartMode = 'tps' | 'gas' | 'util';
type RangeKey = '5m' | '15m' | '1h' | '6h' | '12h' | '24h';

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '5m', label: '5m' }, { key: '15m', label: '15m' }, { key: '1h', label: '1h' },
  { key: '6h', label: '6h' }, { key: '12h', label: '12h' }, { key: '24h', label: '24h' },
];

interface HistoryPoint {
  ts: number;
  time: string;
  tps: number | null;
  gas: number | null;
  util: number | null;
}

interface Stats {
  blockNumber: number;
  gasPrice: number;
  tps: number;
  avgBlockTime: number;
  avgGasUtilization: number;
  txInLatestBlock: number;
  latestBlockTimestamp: number;
  secondsSinceLastBlock: number;
  epoch: {
    current: number;
    blockInEpoch: number;
    blocksPerEpoch: number;
    blocksUntilNext: number;
    secondsUntilNext: number;
    progressPct: number;
  };
  health: {
    state: 'normal' | 'congested' | 'offline';
    reason: string;
  };
}

interface Block {
  number: number;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  miner: string;
  hash: string;
}

interface Tx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  gasPrice: string;
}

const POLL_INTERVAL = 4000;
const HISTORY_POLL_MS = 30_000;

export default function Home() {
  const [network, setNetwork] = useNetwork();
  const [stats, setStats] = useState<Stats | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [range, setRange] = useState<RangeKey>('15m');
  const [chartMode, setChartMode] = useState<ChartMode>('tps');
  const [blocksPage, setBlocksPage] = useState(1);
  const [txsPage, setTxsPage] = useState(1);
  const PAGE_SIZE = 10;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  // Consecutive-failure counter — reset on any successful fetch. The live
  // state only flips to 'offline' after 3+ failures in a row so transient
  // 429s/network blips don't make the status indicator flicker.
  const [failCount, setFailCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const historyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    const net = network;
    try {
      const [statsRes, blocksRes, txsRes] = await Promise.all([
        fetch(`/api/stats?network=${net}`),
        fetch(`/api/blocks?network=${net}`),
        fetch(`/api/transactions?network=${net}`),
      ]);

      if (!statsRes.ok) throw new Error('Stats fetch failed');

      const statsData: Stats = await statsRes.json();
      const blocksData = await blocksRes.json();
      const txsData = await txsRes.json();

      if (statsData.blockNumber) {
        setStats(statsData);
        setLastUpdate(new Date());
      }

      if (blocksData.blocks) setBlocks(blocksData.blocks);
      if (txsData.transactions) setTxs(txsData.transactions);

      setError(null);
      setFailCount(0);
    } catch (e) {
      setError(String(e));
      setFailCount(c => c + 1);
    } finally {
      setLoading(false);
    }
  }, [network]);

  const fetchHistory = useCallback(async (r: RangeKey, mode: ChartMode) => {
    try {
      // TPS mode uses the dedicated per-second collector with bucket
      // aggregation: ~600 bars for long ranges (6h/12h/24h), physical max
      // (300/900) for short ranges limited by 1s block-timestamp granularity.
      // NOTE: long ranges show blank chart for the first hours after PM2
      // restart because tickTpsCollector buffer is RAM-only. Live with it
      // for now — routing to /api/history caused unrelated WARN regression
      // on monad-rpc (see 2026-04-27 16:40 UTC revert). Persisting per-second
      // buckets to InfluxDB is the long-term fix.
      if (mode === 'tps') {
        const res = await fetch(`/api/tps-timeline?range=${r}`, { cache: 'no-store' });
        const json = await res.json() as {
          points: Array<{ ts: number; tps: number; bucketSec: number }>;
        };
        if (json.points) {
          const isShort = r === '5m' || r === '15m';
          const isMedium = r === '1h';
          const mapped: HistoryPoint[] = json.points.map(p => {
            const d = new Date(p.ts * 1000);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return {
              ts: p.ts * 1000,
              time: isShort ? `${hh}:${mm}:${ss}` : isMedium ? `${hh}:${mm}` : `${hh}:${mm}`,
              tps: p.tps,
              gas: null,
              util: null,
            };
          });
          setHistoryPoints(mapped);
        }
        return;
      }
      const res = await fetch(`/api/history?range=${r}`);
      const json = await res.json() as { points: HistoryPoint[] };
      if (json.points) setHistoryPoints(json.points);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setStats(null);
    setBlocks([]);
    setTxs([]);
    fetchAll();

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(fetchAll, POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchAll, network]);

  useEffect(() => {
    fetchHistory(range, chartMode);
    if (historyTimerRef.current) clearInterval(historyTimerRef.current);
    // Refresh cadence: short TPS ranges need frequent updates to keep the
    // rightmost bar fresh. Longer ranges change slowly — poll less often.
    const pollMs =
      chartMode === 'tps' && (range === '5m' || range === '15m' || range === '1h') ? 2_000
      : chartMode === 'tps' ? 15_000
      : HISTORY_POLL_MS;
    historyTimerRef.current = setInterval(() => fetchHistory(range, chartMode), pollMs);
    return () => { if (historyTimerRef.current) clearInterval(historyTimerRef.current); };
  }, [range, chartMode, fetchHistory]);

  const net = NETWORKS[network];
  // Live state is tolerant of a single transient failure:
  //   - No stats + first load → 'loading'
  //   - 3+ failures in a row → 'offline' (real issue)
  //   - Last successful update older than 30s → 'offline' (stale data)
  //   - Otherwise → 'live' (ignore flaky single-request errors)
  const timeSinceUpdate = lastUpdate ? Date.now() - lastUpdate.getTime() : Infinity;
  const liveState: 'live' | 'loading' | 'offline' =
    !stats && loading ? 'loading' :
    failCount >= 3 || timeSinceUpdate > 30_000 ? 'offline' :
    'live';

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

          {/* Network badge */}
          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="badge-gold">{net.name}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Chain ID: {net.chainId}</span>
            {error && (
              <span className="badge-red">RPC Error — {error.slice(0, 60)}</span>
            )}
          </div>

          {/* Network Health — decentralization / client / reorgs / geo */}
          <NetworkHealthCard />

          {/* Health + Epoch row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: 12, marginBottom: 24,
          }}>
            {stats ? (
              <HealthBadge state={stats.health.state} reason={stats.health.reason} />
            ) : (
              // No data yet → show neutral "congested" amber (not alarming red)
              // to avoid the misleading "OFFLINE / STOPPED" flash on cold load.
              <HealthBadge state="congested" reason={loading ? 'Connecting to network…' : 'Awaiting data'} />
            )}
            {stats?.epoch ? (
              <EpochCard
                current={stats.epoch.current}
                blockInEpoch={stats.epoch.blockInEpoch}
                blocksPerEpoch={stats.epoch.blocksPerEpoch}
                blocksUntilNext={stats.epoch.blocksUntilNext}
                secondsUntilNext={stats.epoch.secondsUntilNext}
                progressPct={stats.epoch.progressPct}
              />
            ) : (
              <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)', fontSize: 13, display: 'flex', alignItems: 'center' }}>
                Epoch data loading…
              </div>
            )}
          </div>

          {/* Stat cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12, marginBottom: 24,
          }}>
            <StatCard
              label="Latest Block"
              value={stats ? `#${stats.blockNumber.toLocaleString()}` : '—'}
              accent
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>}
            />
            <StatCard
              label="TPS"
              value={stats ? stats.tps.toFixed(2) : '—'}
              sub="transactions/sec"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
            />
            <StatCard
              label="Gas Price"
              value={stats ? `${stats.gasPrice.toFixed(2)} Gwei` : '—'}
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17"/></svg>}
            />
            <StatCard
              label="Block Time"
              value={stats ? `${stats.avgBlockTime.toFixed(1)}s` : '—'}
              sub="avg last 10 blocks"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
            />
            <StatCard
              label="Tx in last block"
              value={stats ? stats.txInLatestBlock : '—'}
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>}
            />
            <StatCard
              label="Block Utilization"
              value={stats ? `${stats.avgGasUtilization.toFixed(1)}%` : '—'}
              sub="avg gas used / limit"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
            />
          </div>

          {/* Parallel execution panel — Monad-specific retry_pct + exec breakdown */}
          <ParallelismPanel range={range} />

          {/* Top contracts by retry rate — parallelism-conflict hotspots */}
          <TopContractsTable network={network} />

          {/* Chain metrics chart (TPS / Gas / Block utilization) */}
          <ChainChart
            mode={chartMode}
            onModeChange={setChartMode}
            range={range}
            onRangeChange={setRange}
            points={historyPoints}
            currentTps={stats?.tps ?? null}
            currentGas={stats?.gasPrice ?? null}
            currentUtil={stats?.avgGasUtilization ?? null}
          />


          {/* Tables — full-width stacked */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card" style={{ padding: '24px' }}>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, letterSpacing: '0.08em',
                color: 'var(--gold)', marginBottom: 16, paddingBottom: 12,
                borderBottom: '1px solid var(--border)',
              }}>
                Latest Blocks ({blocks.length})
              </div>
              {loading && blocks.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Loading…
                </div>
              ) : blocks.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  No blocks yet
                </div>
              ) : (
                <>
                  <BlocksTable
                    blocks={blocks.slice((blocksPage - 1) * PAGE_SIZE, blocksPage * PAGE_SIZE)}
                    network={network}
                  />
                  <Pagination
                    currentPage={blocksPage}
                    totalPages={Math.max(1, Math.ceil(blocks.length / PAGE_SIZE))}
                    onPageChange={setBlocksPage}
                  />
                </>
              )}
            </div>

            <div className="card" style={{ padding: '24px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16,
                marginBottom: 16, paddingBottom: 12,
                borderBottom: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}>
                <div style={{
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, letterSpacing: '0.08em',
                  color: 'var(--gold)', whiteSpace: 'nowrap',
                }}>
                  Latest Transactions ({txs.length})
                </div>
                <TxSearch />
              </div>
              {loading && txs.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Loading…
                </div>
              ) : txs.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  No transactions in recent blocks
                </div>
              ) : (
                <>
                  <TxTable
                    transactions={txs.slice((txsPage - 1) * PAGE_SIZE, txsPage * PAGE_SIZE)}
                    network={network}
                  />
                  <Pagination
                    currentPage={txsPage}
                    totalPages={Math.max(1, Math.ceil(txs.length / PAGE_SIZE))}
                    onPageChange={setTxsPage}
                  />
                </>
              )}
            </div>
          </div>

          {/* Footer */}
          <div style={{ textAlign: 'center', marginTop: 40, paddingBottom: 32, color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em' }}>
            <a href="https://bee-hive.work" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>BeeHive</a>
            {' '}·{' '}Monad Network Monitor · Updates every {POLL_INTERVAL / 1000}s
          </div>
        </main>
      </div>
    </>
  );
}

const MODE_META: Record<ChartMode, {
  label: string; title: string; unit: string; dataKey: 'tps' | 'gas' | 'util';
  digits: number; yMaxFloor: number;
}> = {
  tps:  { label: 'TPS',  title: 'TRANSACTIONS PER SECOND', unit: '',      dataKey: 'tps',  digits: 2, yMaxFloor: 5 },
  gas:  { label: 'Gas',  title: 'GAS PRICE',               unit: ' gwei', dataKey: 'gas',  digits: 3, yMaxFloor: 5 },
  util: { label: 'Util', title: 'BLOCK UTILIZATION',       unit: '%',     dataKey: 'util', digits: 1, yMaxFloor: 5 },
};

function ChainChart({
  mode, onModeChange, range, onRangeChange, points, currentTps, currentGas, currentUtil,
}: {
  mode: ChartMode;
  onModeChange: (m: ChartMode) => void;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  points: HistoryPoint[];
  currentTps: number | null;
  currentGas: number | null;
  currentUtil: number | null;
}) {
  const meta = MODE_META[mode];
  const currentValue =
    mode === 'tps' ? currentTps :
    mode === 'gas' ? currentGas : currentUtil;

  const values = points.map(p => p[meta.dataKey]).filter((v): v is number => v != null);
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : meta.yMaxFloor;
  const pad = Math.max((dataMax - dataMin) * 0.15, meta.dataKey === 'util' ? 1 : 0.1);
  const yMin = Math.max(0, parseFloat((dataMin - pad).toFixed(2)));
  const yMax = Math.max(meta.yMaxFloor, parseFloat((dataMax + pad).toFixed(2)));

  const color = '#C9A84C';

  const CustomTooltip = ({ active, payload, label: lbl }: {
    active?: boolean; payload?: { value: number }[]; label?: string;
  }) => {
    if (!active || !payload?.length || payload[0].value == null) return null;
    return (
      <div style={{
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '6px 10px', fontSize: 11,
      }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{lbl}</div>
        <div style={{ color, fontFamily: 'DM Mono, monospace', fontSize: 13 }}>
          {payload[0].value.toFixed(meta.digits)}{meta.unit}
        </div>
      </div>
    );
  };

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 14, flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, letterSpacing: '0.08em',
            color: 'var(--gold)',
          }}>
            {meta.title}
          </span>
          {currentValue != null && (
            <span style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, letterSpacing: '0.06em',
              color, lineHeight: 1,
            }}>
              {currentValue.toFixed(meta.digits)}{meta.unit}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['tps', 'gas', 'util'] as const).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              style={{
                padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                background: mode === m ? 'rgba(201,168,76,0.15)' : 'transparent',
                color: mode === m ? 'var(--gold)' : 'var(--text-muted)',
                fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
              }}
            >
              {MODE_META[m].label}
            </button>
          ))}
        </div>
      </div>

      <div style={{
        display: 'flex', justifyContent: 'flex-end', marginBottom: 10,
      }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {RANGES.map(r => {
            const active = range === r.key;
            return (
              <button
                key={r.key}
                onClick={() => onRangeChange(r.key)}
                style={{
                  padding: '3px 9px',
                  fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.05em',
                  background: active ? 'var(--gold)' : 'transparent',
                  color: active ? '#000' : 'var(--text-muted)',
                  border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {points.length < 2 ? (
        <div style={{
          height: 185, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)', fontSize: 12,
        }}>
          Collecting data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={points} margin={{ top: 4, right: 8, left: 4, bottom: 0 }} barCategoryGap={1}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(201,168,76,0.07)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#8A8870', fontSize: 9 }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(201,168,76,0.1)' }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[yMin, yMax]}
              tick={{ fill: '#8A8870', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${v}${meta.unit}`}
              width={56}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(201,168,76,0.05)' }} />
            <Bar dataKey={meta.dataKey} isAnimationActive={false} shape={(props: unknown) => {
              const { x, y, width, height, payload } = props as {
                x: number; y: number; width: number; height: number;
                payload?: HistoryPoint;
              };
              if (!width || !height || height < 0) return <g />;

              // "Pixelated" bar — stack of visually-distinct squares. Size
              // adapts to bar width so narrow bars (wide ranges, 600+ points)
              // still read as squares, not thin stripes.
              const barW = Math.max(width - 1, 1);
              const squareSize = Math.min(Math.max(barW, 4), 7);
              const gap = 2;
              const step = squareSize + gap;
              const count = Math.max(1, Math.floor(height / step));

              // Threshold coloring — similar to the RETRY chart the user liked.
              // TPS/Gas use gold scale; Util adds red at >75% (congestion signal).
              const v = payload?.[meta.dataKey] ?? 0;
              let fillColor = color;
              if (meta.dataKey === 'util') {
                if (v >= 75)      fillColor = '#E05252';       // congested
                else if (v >= 45) fillColor = '#E8A020';       // busy
                else              fillColor = '#C9A84C';       // normal
              }

              const squares = [];
              for (let i = 0; i < count; i++) {
                squares.push(
                  <rect
                    key={i}
                    x={x + (width - barW) / 2}
                    y={y + height - (i + 1) * step + gap / 2}
                    width={barW}
                    height={squareSize}
                    fill={fillColor}
                    rx={1}
                  />
                );
              }
              return <g>{squares}</g>;
            }} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
