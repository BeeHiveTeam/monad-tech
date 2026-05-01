'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import NodeVersionCheck from '@/components/NodeVersionCheck';
import { useNetwork } from '@/lib/useNetwork';
import MainnetSoonCard from '@/components/MainnetSoonCard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Brush, ReferenceLine, Cell,
} from 'recharts';

interface HistoryPoint {
  ts: number;
  time: string;
  cpu: number | null;
  mem: number | null;
}

type Health = 'healthy' | 'degraded' | 'offline';
type RangeKey = '5m' | '15m' | '1h' | '6h' | '12h' | '24h' | 'custom';

interface TimeWindow { start: Date; end: Date; }

interface SubtypeDelta {
  key: string;
  field: string;
  label: string;
  total: number;
  delta: number;
}

interface TimelineEvent { ts: number; increment: number; total: number; }
interface TimelineResponse {
  events: TimelineEvent[];
  samples: number;
  totalIncrements?: number;
  field: string;
  range: string;
  note?: string;
  error?: string;
}

interface LogLine {
  ts: number;
  service: string;
  level: string;
  message: string;
  raw?: string;
  traceId: string | null;
}
interface LogsResponse {
  logs: LogLine[];
  range: string;
  count: number;
  error?: string;
}


type ServiceStatus = 'running' | 'stale' | 'stopped';
interface ServiceInfo {
  key: 'monad' | 'monad-execution' | 'monad-bft' | 'monad-rpc';
  label: string;
  description: string;
  status: ServiceStatus;
  ageSec: number | null;
  metricsCount: number;
  signals: Record<string, number | null>;
}
interface EventDelta {
  blocksync: number;
  consensus: number;
  validation: number;
  network: number;
  coverageSec: number;
  breakdown: {
    blocksync: SubtypeDelta[];
    consensus: SubtypeDelta[];
    validation: SubtypeDelta[];
    network: SubtypeDelta[];
  };
}
type EventCategoryKey = 'blocksync' | 'consensus' | 'validation' | 'network';
interface EventCategoryMeta {
  key: EventCategoryKey;
  label: string;
  help: string;
  subtypes: { key: string; label: string }[];
}

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: '5m',  label: '5m'  },
  { key: '15m', label: '15m' },
  { key: '1h',  label: '1h'  },
  { key: '6h',  label: '6h'  },
  { key: '12h', label: '12h' },
  { key: '24h', label: '24h' },
];

// Known log patterns with operator guidance. `action` = none|monitor|investigate.
const LOG_ANNOTATIONS: Array<{
  pattern: RegExp;
  note: string;
  action: 'none' | 'monitor' | 'investigate';
}> = [
  {
    pattern: /failed to find address for rebroadcast target/,
    note: 'Remote validator unreachable in P2P mesh. The target= pubkey is the offline/unreachable node — not yours. No action needed.',
    action: 'none',
  },
  {
    pattern: /received SyncDone with failure/,
    note: 'Remote peer failed to complete state sync. Transient network issue on the peer\'s side. Normal if infrequent.',
    action: 'none',
  },
  {
    pattern: /dropping proposal.*already received/,
    note: 'Duplicate block proposal arrived via multiple relay paths. Normal deduplication.',
    action: 'none',
  },
  {
    pattern: /local.?timeout/i,
    note: 'BFT consensus round timed out locally. Occasional timeouts are normal; investigate if rate spikes persistently.',
    action: 'monitor',
  },
  {
    pattern: /udp.?decrypt/i,
    note: 'UDP packet decryption failed — usually noise from stale sessions or incompatible peers. Normal.',
    action: 'none',
  },
  {
    pattern: /drop.?ping|drop.?pong/i,
    note: 'P2P ping/pong dropped. Normal peer discovery churn at 250+ peers.',
    action: 'none',
  },
  {
    pattern: /sending keepalive packet/i,
    note: 'Normal P2P keepalive heartbeat.',
    action: 'none',
  },
  {
    pattern: /peer headers request failed|peer payload request failed/i,
    note: 'Block sync request to a peer failed. If delta is growing fast, check peer connectivity.',
    action: 'monitor',
  },
  {
    pattern: /failed timestamp validation/i,
    note: 'A received message had an invalid timestamp. Usually caused by clock skew on the sender\'s node.',
    action: 'none',
  },
];

interface NodeData {
  fetchedAt: number;
  latencyMs: number;
  source: string;
  node: {
    service: string;
    version: string;
    network: string;
    block: { latest: number; testnetTip: number; lagBlocks: number; synced: boolean };
    peers: { total: number; pending: number; upstreamValidators: number };
    traffic: { rxBytes: number; txBytes: number };
    commits: { blocks: number; txs: number };
    events: {
      blocksyncFailures: number;
      consensusAnomalies: number;
      validationErrors: number;
      networkDrops: number;
    };
    eventCategories?: EventCategoryMeta[];
    eventWindows: Record<string, EventDelta | null>;
    services?: ServiceInfo[];
  };
  system: {
    cpu: { load1: number; load5: number; load15: number; cores: number; loadPct: number };
    memory: { usedBytes: number; totalBytes: number; usedPct: number };
    swap: { usedBytes: number; totalBytes: number; usedPct: number };
    disks: Array<{ mountpoint: string; device: string; fsType: string; usedBytes: number; freeBytes: number; totalBytes: number; usedPct: number }>;
    network: Array<{ device: string; rxBytes: number; txBytes: number }>;
  };
  health: { state: Health; reason: string };
  error?: string;
}

const POLL_INTERVAL = 10_000;


const HEALTH_COLORS: Record<Health, { bg: string; border: string; fg: string; dot: string; label: string }> = {
  healthy:  { bg: 'rgba(76,175,110,0.1)',  border: 'rgba(76,175,110,0.3)',  fg: '#4CAF6E', dot: '#4CAF6E', label: 'HEALTHY' },
  degraded: { bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.3)', fg: '#C9A84C', dot: '#C9A84C', label: 'DEGRADED' },
  offline:  { bg: 'rgba(224,82,82,0.1)',  border: 'rgba(224,82,82,0.3)',  fg: '#E05252', dot: '#E05252', label: 'OFFLINE' },
};

function fmtBytes(n: number, digits = 1): string {
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(digits)} ${units[i]}`;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export default function NodePage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<NodeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [range, setRange] = useState<RangeKey>('15m');
  // Custom range state
  const toLocalDT = (d: Date) => {
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  };
  const [customStart, setCustomStart] = useState(() => toLocalDT(new Date(Date.now() - 3600_000)));
  const [customEnd,   setCustomEnd]   = useState(() => toLocalDT(new Date()));
  const [customWindow, setCustomWindow] = useState<TimeWindow | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    blocksync: false, consensus: false, validation: false, network: false, __logs__: false,
  });
  const [eventFilter, setEventFilter] = useState('');
  const [onlyWithEvents, setOnlyWithEvents] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rangeRef = useRef<RangeKey>(range);
  const customWindowRef = useRef<TimeWindow | null>(null);
  useEffect(() => { rangeRef.current = range; }, [range]);
  useEffect(() => { customWindowRef.current = customWindow; }, [customWindow]);

  const fetchHistory = useCallback(async (r: RangeKey, cw?: TimeWindow | null) => {
    try {
      let url: string;
      if (r === 'custom' && cw) {
        url = `/api/history?start=${cw.start.getTime()}&end=${cw.end.getTime()}`;
      } else if (r !== 'custom') {
        url = `/api/history?range=${r}`;
      } else return;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json() as { points: HistoryPoint[] };
      if (json.points?.length) setHistoryPoints(json.points);
    } catch {
      // non-critical
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/node', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok && !json.health) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
      setLastUpdate(new Date());
      setError(json.error ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + polling — both node data and history
  useEffect(() => {
    fetchData();
    fetchHistory(rangeRef.current, customWindowRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      fetchData();
      // History only refreshes in live mode (not custom window)
      if (rangeRef.current !== 'custom') fetchHistory(rangeRef.current);
    }, POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchData, fetchHistory]);

  // Reload history when range/customWindow changes
  useEffect(() => {
    fetchHistory(range, customWindow);
  }, [range, customWindow, fetchHistory]);

  const liveState: 'live' | 'loading' | 'offline' =
    error || data?.health?.state === 'offline' ? 'offline' :
    loading && !data ? 'loading' : 'live';

  const h = data?.health?.state ?? 'offline';
  const hc = HEALTH_COLORS[h];

  const syncStatus = data?.node
    ? data.node.block.testnetTip === 0
      ? { label: 'UNKNOWN', sub: 'tip not reachable', color: '#8A8870' }
      : data.node.block.synced
        ? { label: 'SYNCED', sub: 'following tip', color: '#4CAF6E' }
        : { label: 'SYNCING', sub: `${fmtNum(data.node.block.lagBlocks)} behind`, color: '#C9A84C' }
    : null;

  if (network === 'mainnet') {
    return (
      <>
        <HexBg />
        <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
          <SiteHeader network={network} onNetworkChange={setNetwork} liveState="live" lastUpdate={null} />
          <main className="site-main">
            <TabNav />
            <MainnetSoonCard
              title="VALIDATOR NODE"
              description="This page renders the live state of our own Monad validator (peer count, sync, executor metrics, log feed). Mainnet view will activate once we run a mainnet node."
            />
          </main>
        </div>
      </>
    );
  }

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
            <span className="badge-gold">BeeHive Validator Node</span>
            {data?.node && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {data.node.service} · v{data.node.version} · {data.node.network}
              </span>
            )}
            {data?.latencyMs !== undefined && (
              <span style={{ fontSize: 11, color: 'rgba(138,136,112,0.5)' }}>
                metrics pull {data.latencyMs}ms
              </span>
            )}
          </div>

          {/* Health banner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16,
            padding: '16px 24px',
            background: hc.bg,
            border: `1px solid ${hc.border}`,
            borderRadius: 12,
            marginBottom: 24,
          }}>
            <span style={{
              width: 14, height: 14, borderRadius: '50%',
              background: hc.dot,
              boxShadow: `0 0 14px ${hc.dot}`,
              animation: h === 'healthy' ? 'pulse 2s infinite' : 'none',
              flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, letterSpacing: '0.1em', color: hc.fg, lineHeight: 1 }}>
                NODE {hc.label}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {data?.health?.reason ?? (loading ? 'Connecting to metrics endpoint…' : 'No data')}
              </div>
            </div>
          </div>

          {/* Stat cards */}
          {data?.node && syncStatus && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12, marginBottom: 24,
          }}>
            <StatBox
              label="Node block"
              value={`#${fmtNum(data.node.block.latest)}`}
              sub={data.node.block.testnetTip > 0
                ? `tip #${fmtNum(data.node.block.testnetTip)} · lag ${fmtNum(data.node.block.lagBlocks)}`
                : 'tip unknown'}
              accent
            />
            <StatBox
              label="Sync status"
              value={syncStatus.label}
              sub={syncStatus.sub}
              valueColor={syncStatus.color}
            />
            <StatBox
              label="Peers"
              value={fmtNum(data.node.peers.total)}
              sub={`upstream ${data.node.peers.upstreamValidators} · pending ${data.node.peers.pending}`}
            />
            <StatBox
              label="Commits processed"
              value={fmtNum(data.node.commits.blocks)}
              sub={`${fmtNum(data.node.commits.txs)} tx commits`}
            />
            <StatBox
              label="P2P received"
              value={fmtBytes(data.node.traffic.rxBytes)}
              sub="raptorcast authenticated"
            />
            <StatBox
              label="P2P sent"
              value={fmtBytes(data.node.traffic.txBytes)}
              sub="raptorcast authenticated"
            />
          </div>
          )}

          {/* Global range selector */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexWrap: 'wrap', gap: 10,
            }}>
              <span style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, letterSpacing: '0.12em',
                color: 'var(--text-muted)',
              }}>
                TIME RANGE
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {RANGES.map(r => {
                  const eventsAvailable = !data?.node?.events || !!data?.node?.eventWindows?.[r.key];
                  const active = range === r.key;
                  return (
                    <button
                      key={r.key}
                      onClick={() => { setRange(r.key); setCustomWindow(null); }}
                      style={{
                        padding: '4px 10px',
                        fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.05em',
                        background: active ? 'var(--gold)' : 'transparent',
                        color: active ? '#000' : 'var(--text-muted)',
                        border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                        borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s',
                        opacity: (!eventsAvailable && data?.node?.events) ? 0.4 : 1,
                      }}
                    >
                      {r.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => setRange('custom')}
                  style={{
                    padding: '4px 10px',
                    fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.05em',
                    background: range === 'custom' ? 'rgba(201,168,76,0.15)' : 'transparent',
                    color: range === 'custom' ? 'var(--gold)' : 'var(--text-muted)',
                    border: `1px solid ${range === 'custom' ? 'var(--gold)' : 'var(--border)'}`,
                    borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  CUSTOM
                </button>
              </div>
            </div>
            {range === 'custom' && (
              <div style={{
                marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <input
                  type="datetime-local"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  style={{
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '4px 10px', fontSize: 11,
                    color: 'var(--text)', outline: 'none', fontFamily: 'DM Mono, monospace',
                    colorScheme: 'dark',
                  }}
                />
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                <input
                  type="datetime-local"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  style={{
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '4px 10px', fontSize: 11,
                    color: 'var(--text)', outline: 'none', fontFamily: 'DM Mono, monospace',
                    colorScheme: 'dark',
                  }}
                />
                <button
                  onClick={() => {
                    const s = new Date(customStart);
                    const e = new Date(customEnd);
                    if (s < e) setCustomWindow({ start: s, end: e });
                  }}
                  style={{
                    padding: '4px 14px',
                    fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.05em',
                    background: 'var(--gold)', color: '#000',
                    border: '1px solid var(--gold)',
                    borderRadius: 4, cursor: 'pointer',
                  }}
                >
                  APPLY
                </button>
                {customWindow && (
                  <span style={{ fontSize: 10, color: 'rgba(138,136,112,0.6)', fontFamily: 'DM Mono, monospace' }}>
                    {customWindow.start.toLocaleTimeString('ru-RU', { hour12: false })} — {customWindow.end.toLocaleTimeString('ru-RU', { hour12: false })}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Monad client version check (uses /api/network-health) */}
          <NodeVersionCheck />

          {/* Node services */}
          {data?.node?.services && data.node.services.length > 0 && (
            <div className="card" style={{ padding: '20px 24px', marginBottom: 24 }}>
              <div style={{
                fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em',
                color: 'var(--gold)', marginBottom: 14,
              }}>
                NODE SERVICES
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 10,
              }}>
                {data.node.services.map(sv => (
                  <ServiceCard key={sv.key} service={sv} />
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 10, color: 'rgba(138,136,112,0.5)', lineHeight: 1.5 }}>
                Status is inferred from the presence and freshness of metrics with the matching prefix (fresh &lt; 30s). True systemd state (active/activating/failed) requires an agent on the validator — not yet available.
              </div>
            </div>
          )}

          {/* Node events / warn / error panel */}
          {data?.node?.events && (
            <div className="card" style={{ padding: '20px 24px', marginBottom: 24 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 14, gap: 12, flexWrap: 'wrap',
              }}>
                <span style={{
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em',
                  color: 'var(--gold)',
                }}>
                  NODE EVENTS · LAST {range.toUpperCase()}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="Filter by error type…"
                    value={eventFilter}
                    onChange={e => setEventFilter(e.target.value)}
                    style={{
                      background: 'var(--surface2)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: '4px 10px', fontSize: 12,
                      color: 'var(--text)', outline: 'none', width: 200,
                      fontFamily: 'DM Mono, monospace',
                    }}
                  />
                  <label style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.05em',
                  }}>
                    <input
                      type="checkbox"
                      checked={onlyWithEvents}
                      onChange={e => setOnlyWithEvents(e.target.checked)}
                      style={{ accentColor: 'var(--gold)' }}
                    />
                    Only with events
                  </label>
                </div>
              </div>
              {(() => {
                if (range === 'custom') {
                  return (
                    <div style={{ padding: '20px 0', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                      Event counters are only available for standard ranges (5m–24h). Use the log panel below for custom windows.
                    </div>
                  );
                }
                const w = data.node.eventWindows?.[range];
                if (!w) {
                  return (
                    <div style={{ padding: '20px 0', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                      Not enough history for the &quot;{range}&quot; window. Data is being collected — try a smaller range.
                    </div>
                  );
                }
                const totals: Record<EventCategoryKey, number> = {
                  blocksync: data.node.events.blocksyncFailures,
                  consensus: data.node.events.consensusAnomalies,
                  validation: data.node.events.validationErrors,
                  network: data.node.events.networkDrops,
                };
                const catDeltas: Record<EventCategoryKey, number> = {
                  blocksync: w.blocksync, consensus: w.consensus,
                  validation: w.validation, network: w.network,
                };
                const helpMap: Record<EventCategoryKey, string> = {
                  blocksync: 'peer/self headers, payload, timeouts',
                  consensus: 'local timeouts, TCs created, validation fail',
                  validation: 'bad sig / round / epoch / author',
                  network: 'drop/timeout/decrypt/raptorcast rx err',
                };
                const labelMap: Record<EventCategoryKey, string> = {
                  blocksync: 'Blocksync failures',
                  consensus: 'Consensus anomalies',
                  validation: 'Validation errors',
                  network: 'Network drops',
                };
                const cats: EventCategoryKey[] = ['blocksync', 'consensus', 'validation', 'network'];
                const q = eventFilter.trim().toLowerCase();

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {cats.map(catKey => {
                      const sub = (w.breakdown?.[catKey] ?? []);
                      const filtered = sub
                        .filter(s => !q || s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
                        .filter(s => !onlyWithEvents || s.delta > 0);
                      const isExpanded = expanded[catKey] || (q !== '' && filtered.length > 0);
                      return (
                        <EventCategoryCard
                          key={catKey}
                          label={labelMap[catKey]}
                          help={helpMap[catKey]}
                          delta={catDeltas[catKey]}
                          total={totals[catKey]}
                          coverageSec={w.coverageSec}
                          expanded={isExpanded}
                          onToggle={() => setExpanded(prev => ({ ...prev, [catKey]: !prev[catKey] }))}
                          subtypes={filtered}
                          hasFilter={q !== '' || onlyWithEvents}
                          totalSubtypes={sub.length}
                          range={range}
                          customWindow={customWindow}
                        />
                      );
                    })}
                    <LogDerivedCategoryCard
                      range={range}
                      customWindow={customWindow}
                      expanded={expanded['__logs__'] ?? false}
                      onToggle={() => setExpanded(prev => ({ ...prev, __logs__: !prev['__logs__'] }))}
                      filter={q}
                      onlyWithEvents={onlyWithEvents}
                    />
                  </div>
                );
              })()}
            </div>
          )}

          {/* System cards */}
          {data?.system && (
          <>
            <div style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em',
              color: 'var(--text-muted)', marginBottom: 12, marginTop: 8,
            }}>
              HOST SYSTEM · LAST {range.toUpperCase()}
            </div>

            <MetricChart
              label="CPU Load"
              unit="%"
              dataKey="cpu"
              points={historyPoints}
              currentValue={data.system.cpu.loadPct}
              sub={`load1 ${data.system.cpu.load1.toFixed(2)} · load5 ${data.system.cpu.load5.toFixed(2)} · load15 ${data.system.cpu.load15.toFixed(2)} · ${data.system.cpu.cores} cores`}
              thresholdWarn={60}
              thresholdCrit={80}
            />

            <MetricChart
              label="Memory Usage"
              unit="%"
              dataKey="mem"
              points={historyPoints}
              currentValue={data.system.memory.usedPct}
              sub={`${fmtBytes(data.system.memory.usedBytes)} used / ${fmtBytes(data.system.memory.totalBytes)} total`}
              thresholdWarn={75}
              thresholdCrit={90}
            />

            {data.system.swap?.totalBytes > 0 && (
              <div style={{ marginBottom: 12 }}>
                <SwapCard swap={data.system.swap} />
              </div>
            )}


            {data.system.disks.length > 0 && (
              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 14 }}>
                  DISK USAGE
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {data.system.disks.map(d => (
                    <div key={d.mountpoint}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                        <span style={{ fontFamily: 'DM Mono, monospace', color: 'var(--text)' }}>
                          {d.mountpoint} <span style={{ color: 'var(--text-muted)' }}>({d.device} · {d.fsType})</span>
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)} · {d.usedPct.toFixed(1)}%
                        </span>
                      </div>
                      <div style={{ width: '100%', height: 6, background: 'rgba(201,168,76,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(d.usedPct, 100)}%`, height: '100%',
                          background: d.usedPct > 90 ? '#E05252' : d.usedPct > 75 ? '#C9A84C' : 'var(--gold)',
                          borderRadius: 3,
                        }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  trieDB is stored inside this filesystem. A dedicated DB-size metric would require a host agent on the validator — see note below.
                </div>
              </div>
            )}

          </>
          )}

          {/* Log panel */}
          <LogPanel range={range} customWindow={customWindow} />

          {error && !data && (
            <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
              Metrics endpoint error: {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 32 }}>
            Data from the otelcol Prometheus endpoint on the BeeHive validator ({data?.source || 'no source'}).
            Refreshed every {POLL_INTERVAL / 1000}s. CPU and memory history is stored in InfluxDB (db &quot;monad&quot;).
            &quot;Node events&quot; counters tally errors for the selected interval (5m–24h); long windows become available as history accumulates.
            Validator logs are shipped via otelcol-contrib journald-receiver → Loki, retained 7 days.
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

function SwapCard({ swap }: { swap: { usedBytes: number; totalBytes: number; usedPct: number } }) {
  const color = swap.usedPct > 50 ? '#E05252' : swap.usedPct > 20 ? '#C9A84C' : 'var(--text-muted)';
  return (
    <div className="card card-hover" style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Swap usage
        </span>
        <span style={{ fontSize: 24, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.06em', color, lineHeight: 1 }}>
          {swap.usedPct < 0.1 ? '0%' : `${swap.usedPct.toFixed(1)}%`}
        </span>
      </div>
      <div style={{ width: '100%', height: 6, background: 'rgba(201,168,76,0.08)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${Math.min(swap.usedPct, 100)}%`, height: '100%',
          background: color,
          borderRadius: 3,
          transition: 'width 0.3s',
        }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {fmtBytes(swap.usedBytes)} used · {fmtBytes(swap.totalBytes)} total
      </div>
    </div>
  );
}

function StatBox({
  label, value, sub, accent, valueColor,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  valueColor?: string;
}) {
  return (
    <div className="card card-hover" style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div style={{
        fontSize: 26, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.06em',
        color: valueColor ?? (accent ? 'var(--gold)' : 'var(--text)'),
        lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function MetricChart({
  label, unit, dataKey, points, currentValue, sub, thresholdWarn, thresholdCrit,
}: {
  label: string;
  unit: string;
  dataKey: 'cpu' | 'mem';
  points: HistoryPoint[];
  currentValue: number;
  sub: string;
  thresholdWarn: number;
  thresholdCrit: number;
}) {
  const color = currentValue >= thresholdCrit ? '#E05252'
    : currentValue >= thresholdWarn ? '#E8A020' : '#C9A84C';

  // Auto Y scale: min/max of data with padding
  const values = points.map(p => p[dataKey]).filter((v): v is number => v != null);
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 100;
  const pad = Math.max((dataMax - dataMin) * 0.15, 1);
  const yMin = Math.max(0, parseFloat((dataMin - pad).toFixed(1)));
  const yMax = Math.min(100, parseFloat((dataMax + pad).toFixed(1)));

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
          {payload[0].value.toFixed(1)}{unit}
        </div>
      </div>
    );
  };

  return (
    <div className="card" style={{ padding: '18px 22px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 28, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.06em', color, lineHeight: 1 }}>
            {currentValue.toFixed(1)}{unit}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>
        </div>
      </div>

      {points.length < 2 ? (
        <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Collecting data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={185}>
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
              tickFormatter={v => `${v}%`}
              width={46}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(201,168,76,0.05)' }} />
            {thresholdWarn < yMax && (
              <ReferenceLine
                y={thresholdWarn}
                stroke="#C9A84C"
                strokeDasharray="4 3"
                strokeOpacity={0.5}
                label={{ value: `${thresholdWarn}%`, fill: '#C9A84C', fontSize: 9, position: 'insideTopRight' }}
              />
            )}
            {thresholdCrit < yMax && (
              <ReferenceLine
                y={thresholdCrit}
                stroke="#E05252"
                strokeDasharray="4 3"
                strokeOpacity={0.5}
                label={{ value: `${thresholdCrit}%`, fill: '#E05252', fontSize: 9, position: 'insideTopRight' }}
              />
            )}
            <Bar dataKey={dataKey} shape={(props: unknown) => {
              const { x, y, width, height, value } = props as { x: number; y: number; width: number; height: number; value: number };
              if (!width || !height || height < 0) return <g />;
              const v = value ?? 0;
              const c = v >= thresholdCrit ? '#E05252' : v >= thresholdWarn ? '#C9A84C' : color;
              const squareSize = 3;
              const gap = 1;
              const step = squareSize + gap;
              const count = Math.floor(height / step);
              const squares = [];
              for (let i = 0; i < count; i++) {
                // i=0 is bottom square (brightest), i=count-1 is top (slightly dimmer)
                const opacity = 0.95 - (i / Math.max(count - 1, 1)) * 0.3;
                squares.push(
                  <rect
                    key={i}
                    x={x + 0.5}
                    y={y + height - (i + 1) * step + gap}
                    width={Math.max(width - 1, 1)}
                    height={squareSize}
                    fill={c}
                    fillOpacity={opacity}
                    rx={0.5}
                  />
                );
              }
              return <g>{squares}</g>;
            }}>
            </Bar>
            <Brush
              dataKey="time"
              height={22}
              stroke="rgba(201,168,76,0.2)"
              fill="rgba(8,8,8,0.6)"
              travellerWidth={6}
              tickFormatter={() => ''}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function EventCategoryCard({
  label, help, delta, total, coverageSec, expanded, onToggle,
  subtypes, hasFilter, totalSubtypes, range, customWindow,
}: {
  label: string;
  help: string;
  delta: number;
  total: number;
  coverageSec: number;
  expanded: boolean;
  onToggle: () => void;
  subtypes: SubtypeDelta[];
  hasFilter: boolean;
  totalSubtypes: number;
  range: RangeKey;
  customWindow: TimeWindow | null;
}) {
  const color = delta > 0 ? '#E05252' : 'var(--text-muted)';
  const perMin = coverageSec > 0 ? (delta / (coverageSec / 60)) : 0;
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      background: 'rgba(255,255,255,0.01)', overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', padding: '12px 14px', background: 'transparent', border: 0,
          cursor: 'pointer', textAlign: 'left', color: 'inherit',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 11,
          color: 'var(--gold)', width: 10, flexShrink: 0, transition: 'transform 0.15s',
          display: 'inline-block',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}>
            {label}
          </span>
          <span style={{ fontSize: 10, color: 'rgba(138,136,112,0.7)' }}>{help}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 20, color }}>
              {delta.toLocaleString('en-US')}
            </span>
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: 'var(--text-muted)' }}>
              {perMin >= 0.1 ? `≈ ${perMin.toFixed(1)}/min` : perMin > 0 ? `≈ ${(perMin * 60).toFixed(1)}/h` : 'steady'}
            </span>
          </div>
          <span style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)' }}>
            total since boot: {total.toLocaleString('en-US')}
          </span>
        </div>
      </button>
      {expanded && (
        <div style={{
          padding: '8px 14px 12px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(0,0,0,0.25)',
        }}>
          {subtypes.length === 0 ? (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              {hasFilter
                ? `No matching subtypes (of ${totalSubtypes})`
                : 'No subtype data available.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {subtypes.map(st => (
                <SubtypeRow key={st.key} subtype={st} range={range} customWindow={customWindow} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-subtype operator guidance. `logQuery` is a regex pattern that matches the
// corresponding journald log line (when Monad emits one — many counters are
// metric-only and have no log). `service` filters which systemd unit to search.
const SUBTYPE_GUIDE: Record<string, {
  logQuery?: string;
  service?: string;
  note: string;
  action: 'none' | 'monitor' | 'investigate';
}> = {
  // ── blocksync (bs_) ───────────────────────────────────────────────
  bs_peer_headers:      { note: 'Peer failed to respond to a block-headers sync request. Peer-side churn. No action unless rate spikes.', action: 'monitor' },
  bs_peer_payload:      { note: 'Peer failed to respond to a block-payload sync request. Same as headers — peer-side.', action: 'monitor' },
  bs_req_timeout:       { note: 'Block sync request timed out. Transient network issue on the sync peer.', action: 'monitor' },
  bs_req_no_peers:      { note: 'No peers available to serve a block sync request. Check your P2P connectivity if frequent.', action: 'investigate' },
  bs_headers_val_fail:  { note: 'Received corrupt block headers. Peer misbehaviour — not your node.', action: 'none' },
  bs_headers_resp_fail: { note: 'Malformed headers response from peer. Peer-side issue.', action: 'none' },
  bs_payload_resp_fail: { note: 'Malformed payload response from peer. Peer-side issue.', action: 'none' },

  // ── consensus (cs_) ───────────────────────────────────────────────
  cs_failed_ts_val:     { note: 'Received message with invalid timestamp (sender\'s clock skew). Peer-side.', action: 'none' },
  cs_failed_txn_val:    { note: 'Transaction validation failed inside a proposal. Peer-side.', action: 'none' },
  cs_failed_randao:     { note: 'RANDAO validation failed. Peer-side protocol violation.', action: 'none' },
  cs_inv_proposal_leader:{ note: 'Received proposal from a non-leader node. Peer-side protocol issue.', action: 'none' },
  cs_inv_recovery_leader:{ note: 'Invalid recovery leader detected. Peer-side.', action: 'none' },
  cs_local_timeout:     { logQuery: 'local timeout', note: 'BFT consensus round timed out locally — not enough votes in time. Rare timeouts are normal; watch for sustained spikes (network/resource issues).', action: 'monitor' },
  cs_rx_base_fee:       { note: 'Base-fee-related consensus event. Usually informational.', action: 'none' },
  cs_created_tc:        { note: 'Created a Timeout Certificate. Normal BFT recovery after a local timeout.', action: 'none' },

  // ── validation (val_) ─────────────────────────────────────────────
  val_dup_tc_tip:       { note: 'Duplicate TC at tip received. Peer-side protocol issue.', action: 'none' },
  val_empty_signers_tc: { note: 'TC with empty signers received. Peer-side malformed message.', action: 'none' },
  val_insufficient_stake:{ note: 'Message with insufficient stake signatures. Peer-side.', action: 'none' },
  val_invalid_author:   { note: 'Message from an unknown/invalid author. Peer-side.', action: 'none' },
  val_invalid_epoch:    { note: 'Message references invalid epoch — sender\'s state drift.', action: 'none' },
  val_invalid_seq_num:  { note: 'Invalid sequence number. Peer-side.', action: 'none' },
  val_invalid_sig:      { note: 'Invalid signature on received message. Peer-side.', action: 'none' },
  val_invalid_tc_round: { note: 'Invalid TC round. Peer-side.', action: 'none' },
  val_invalid_version:  { note: 'Incompatible protocol version from peer. Peer-side.', action: 'none' },
  val_invalid_vote_msg: { note: 'Invalid vote message. Peer-side.', action: 'none' },
  val_malformed_sig:    { note: 'Malformed signature. Peer-side.', action: 'none' },
  val_sigs_dup_node:    { note: 'Duplicate signatures from one node. Peer-side.', action: 'none' },
  val_too_many_tc_tip:  { note: 'Too many TCs at tip. Peer-side.', action: 'none' },
  val_data_unavail:     { note: 'Required data was unavailable. Usually transient.', action: 'monitor' },

  // ── network (net_) ────────────────────────────────────────────────
  net_drop_ping:        { note: 'Incoming ping dropped. Normal P2P churn at 250+ peers — no corresponding log line.', action: 'none' },
  net_drop_pong:        { note: 'Incoming pong dropped. Normal churn — no corresponding log.', action: 'none' },
  net_lookup_timeout:   { note: 'Peer lookup timed out. Transient discovery issue.', action: 'none' },
  net_ping_timeout:     { note: 'Ping to peer timed out — peer likely offline. Normal churn.', action: 'none' },
  net_rc_recv_err:      { note: 'Raptorcast packet receive error. Normal P2P noise at scale.', action: 'none' },
  net_udp_decrypt:      { note: 'UDP packet decryption failed. Noise from stale sessions/incompatible nodes.', action: 'none' },
};

function SubtypeRow({ subtype, range, customWindow }: {
  subtype: SubtypeDelta; range: RangeKey; customWindow: TimeWindow | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<TimelineResponse | null>(null);
  const [logsResp, setLogsResp] = useState<LogsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const active = subtype.delta > 0;

  const guide = SUBTYPE_GUIDE[subtype.key as keyof typeof SUBTYPE_GUIDE]
    ?? SUBTYPE_GUIDE[subtype.field as keyof typeof SUBTYPE_GUIDE];

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const promises: Promise<unknown>[] = [
        fetch(`/api/node/event-timeline?field=${encodeURIComponent(subtype.field)}&range=${range}`, { cache: 'no-store' })
          .then(r => r.json()),
      ];
      // Fetch matching log lines only if this counter has a known log pattern
      if (guide?.logQuery) {
        const svc = guide.service ?? 'monad-bft';
        let url: string;
        if (range === 'custom' && customWindow) {
          url = `/api/node/logs?start=${customWindow.start.getTime()}&end=${customWindow.end.getTime()}`;
        } else {
          url = `/api/node/logs?range=${range !== 'custom' ? range : '1h'}`;
        }
        url += `&service=${svc}&level=DEBUG&limit=100&q=${encodeURIComponent(guide.logQuery)}`;
        promises.push(fetch(url, { cache: 'no-store' }).then(r => r.json()));
      }
      const [tj, lj] = await Promise.all(promises) as [TimelineResponse, LogsResponse | undefined];
      if (tj.error) throw new Error(tj.error);
      setResp(tj);
      setLogsResp(lj ?? null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [subtype.field, range, customWindow, guide]);

  // Reload when range changes while open
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <div style={{
      borderRadius: 4, overflow: 'hidden',
      background: active ? 'rgba(224,82,82,0.05)' : 'transparent',
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', background: 'transparent', border: 0, cursor: 'pointer',
          padding: '6px 8px', textAlign: 'left', color: 'inherit',
          display: 'grid', gridTemplateColumns: '14px 1fr 80px 100px',
          gap: 12, alignItems: 'center',
        }}
      >
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 9,
          color: 'var(--text-muted)', opacity: 0.7,
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>▸</span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{
            fontSize: 12, color: active ? 'var(--text)' : 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {subtype.label}
          </span>
          <span style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)', fontFamily: 'DM Mono, monospace' }}>
            {subtype.key}
          </span>
        </div>
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 14,
          color: active ? '#E05252' : 'var(--text-muted)',
          textAlign: 'right',
        }}>
          {active ? `+${subtype.delta.toLocaleString('en-US')}` : '0'}
        </span>
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 10,
          color: 'rgba(138,136,112,0.6)', textAlign: 'right',
        }}>
          total {subtype.total.toLocaleString('en-US')}
        </span>
      </button>
      {open && (
        <div style={{
          padding: '10px 14px 12px 34px',
          borderTop: '1px solid rgba(201,168,76,0.06)',
          fontSize: 11, color: 'var(--text-muted)',
        }}>
          {guide && (() => {
            const actionColor = guide.action === 'none'
              ? 'rgba(138,136,112,0.65)'
              : guide.action === 'monitor' ? '#E8A020' : '#E05252';
            const icon = guide.action === 'none' ? 'ℹ' : guide.action === 'monitor' ? '⚠' : '✕';
            const label = guide.action === 'none'
              ? 'NO ACTION NEEDED'
              : guide.action === 'monitor' ? 'MONITOR' : 'INVESTIGATE';
            return (
              <div style={{
                marginBottom: 12, padding: '8px 10px',
                border: `1px solid ${guide.action === 'none' ? 'rgba(138,136,112,0.15)' : actionColor + '40'}`,
                borderRadius: 4, background: 'rgba(0,0,0,0.3)',
              }}>
                <div style={{
                  display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4,
                  fontSize: 9, letterSpacing: '0.08em',
                }}>
                  <span style={{ color: actionColor, fontSize: 12 }}>{icon}</span>
                  <span style={{ color: actionColor, fontWeight: 600 }}>{label}</span>
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text)', lineHeight: 1.5,
                  fontFamily: 'DM Mono, monospace',
                }}>
                  {guide.note}
                </div>
              </div>
            );
          })()}
          {loading && <div>Loading…</div>}
          {err && <div style={{ color: '#E05252' }}>Error: {err}</div>}
          {!loading && !err && logsResp && (
            <LogsView
              resp={logsResp}
              header={`MATCHING LOG LINES · query="${guide?.logQuery ?? ''}"`}
              maxHeight={320}
            />
          )}
          {!loading && !err && !logsResp && resp && (() => {
            const totalInc = resp.totalIncrements ?? resp.events.length;
            return (
              <div style={{
                padding: '8px 10px',
                border: '1px dashed rgba(138,136,112,0.15)', borderRadius: 4,
                fontSize: 10, color: 'rgba(138,136,112,0.6)',
                fontFamily: 'DM Mono, monospace', lineHeight: 1.6,
              }}>
                <div>Counter incremented {totalInc} time{totalInc === 1 ? '' : 's'} in this window (current total: {subtype.total.toLocaleString('en-US')}).</div>
                <div style={{ marginTop: 2, fontStyle: 'italic' }}>
                  Monad does not emit a journald log for this counter — only the Prometheus metric is available.
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  FATAL: '#E05252', ERROR: '#E05252', WARN: '#E8A020',
  INFO: '#8A8870', DEBUG: 'rgba(138,136,112,0.6)', TRACE: 'rgba(138,136,112,0.5)',
};

function LogRow({ log: l }: { log: LogLine }) {
  const [open, setOpen] = useState(false);
  const d = new Date(l.ts);
  const time = d.toLocaleTimeString('ru-RU', { hour12: false });
  const date = d.toLocaleDateString('ru-RU', { month: '2-digit', day: '2-digit' });
  const levelColor = LEVEL_COLOR[l.level] ?? 'var(--text-muted)';
  const annIdx = LOG_ANNOTATIONS.findIndex(a => a.pattern.test(l.message));
  const ann = annIdx >= 0 ? LOG_ANNOTATIONS[annIdx] : null;
  const dimmed = ann?.action === 'none';
  const hasRaw = !!l.raw && l.raw !== l.message;
  return (
    <div
      style={{
        borderBottom: '1px solid rgba(201,168,76,0.04)',
        opacity: dimmed && !open ? 0.6 : 1,
      }}
    >
      <div
        onClick={hasRaw ? () => setOpen(v => !v) : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: '12px 110px 54px 110px 1fr',
          gap: 8, alignItems: 'start',
          padding: '5px 10px',
          fontFamily: 'DM Mono, monospace',
          fontSize: 11, lineHeight: 1.4,
          cursor: hasRaw ? 'pointer' : 'default',
        }}
      >
        <span style={{
          color: 'rgba(138,136,112,0.5)', fontSize: 9,
          transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.1s',
          visibility: hasRaw ? 'visible' : 'hidden',
        }}>▸</span>
        <span style={{ color: 'var(--text-muted)' }}>{date} {time}</span>
        <span style={{ color: levelColor, fontWeight: 500 }}>{l.level}</span>
        <span style={{ color: 'rgba(138,136,112,0.7)' }}>{l.service}</span>
        <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {l.message}
        </span>
      </div>
      {open && hasRaw && (
        <div style={{
          padding: '6px 14px 10px 34px',
          background: 'rgba(0,0,0,0.4)',
          fontFamily: 'DM Mono, monospace',
          fontSize: 10, lineHeight: 1.5,
          color: 'rgba(200,200,180,0.75)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          <div style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)', letterSpacing: '0.08em', marginBottom: 4 }}>
            RAW JOURNALD LINE
          </div>
          {l.raw}
        </div>
      )}
    </div>
  );
}

function LogsView({ resp, header, maxHeight = 260 }: {
  resp: LogsResponse | null;
  header?: string;
  maxHeight?: number;
}) {
  if (!resp) return null;
  if (resp.error) {
    return (
      <div style={{ marginTop: 14, fontSize: 10, color: '#E05252', lineHeight: 1.5 }}>
        logs: {resp.error}
      </div>
    );
  }
  if (!resp.logs.length) {
    return (
      <div style={{
        marginTop: 14, padding: '8px 10px',
        border: '1px dashed rgba(201,168,76,0.1)', borderRadius: 4,
        fontSize: 10, color: 'rgba(138,136,112,0.7)', lineHeight: 1.5,
      }}>
        {header ?? 'LOG MESSAGES (WARN+)'} — no entries in the selected window.
      </div>
    );
  }
  // Build annotation summary: group by known pattern, count occurrences
  interface AnnMatch { annIdx: number; count: number; }
  const annCounts = new Map<number, number>();
  for (const l of resp.logs) {
    for (let ai = 0; ai < LOG_ANNOTATIONS.length; ai++) {
      if (LOG_ANNOTATIONS[ai].pattern.test(l.message)) {
        annCounts.set(ai, (annCounts.get(ai) ?? 0) + 1);
        break;
      }
    }
  }
  const annMatches: AnnMatch[] = Array.from(annCounts.entries())
    .map(([annIdx, count]) => ({ annIdx, count }))
    .sort((a, b) => b.count - a.count);
  const unknownCount = resp.logs.length - Array.from(annCounts.values()).reduce((s, v) => s + v, 0);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 10, color: 'rgba(138,136,112,0.7)', marginBottom: 6, letterSpacing: '0.05em' }}>
        {header ?? 'LOG MESSAGES (WARN+)'} · {resp.count} lines
      </div>

      {/* Annotation summary */}
      {annMatches.length > 0 && (
        <div style={{
          marginBottom: 8, padding: '8px 10px',
          border: '1px solid rgba(201,168,76,0.08)', borderRadius: 4,
          background: 'rgba(0,0,0,0.3)',
        }}>
          <div style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)', letterSpacing: '0.08em', marginBottom: 5 }}>
            KNOWN PATTERNS · {annMatches.length} detected
          </div>
          {annMatches.map(({ annIdx, count }) => {
            const ann = LOG_ANNOTATIONS[annIdx];
            const actionColor = ann.action === 'none'
              ? 'rgba(138,136,112,0.45)'
              : ann.action === 'monitor' ? '#E8A020' : '#E05252';
            const icon = ann.action === 'none' ? 'ℹ' : ann.action === 'monitor' ? '⚠' : '✕';
            return (
              <div key={annIdx} style={{
                display: 'grid', gridTemplateColumns: '16px 50px 1fr',
                gap: 6, alignItems: 'start', marginBottom: 3,
                fontFamily: 'DM Mono, monospace', fontSize: 10, lineHeight: 1.4,
              }}>
                <span style={{ color: actionColor }}>{icon}</span>
                <span style={{ color: actionColor, fontWeight: 500 }}>×{count}</span>
                <span style={{ color: 'rgba(138,136,112,0.7)' }}>{ann.note}</span>
              </div>
            );
          })}
          {unknownCount > 0 && (
            <div style={{
              fontSize: 10, color: 'rgba(138,136,112,0.4)',
              fontFamily: 'DM Mono, monospace', marginTop: 3,
            }}>
              ℹ ×{unknownCount} unrecognized — review logs below
            </div>
          )}
        </div>
      )}

      <div style={{
        maxHeight, overflowY: 'auto',
        border: '1px solid rgba(201,168,76,0.08)', borderRadius: 4,
        background: 'rgba(0,0,0,0.55)',
      }}>
        {resp.logs.map((l, i) => (
          <LogRow key={`${l.ts}-${i}`} log={l} />
        ))}
      </div>
    </div>
  );
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const LOG_LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG: 'rgba(138,136,112,0.55)',
  INFO:  '#8A8870',
  WARN:  '#E8A020',
  ERROR: '#E05252',
};
const LOG_SERVICES = [
  { key: '',                 label: 'ALL'  },
  { key: 'monad-bft',       label: 'BFT'  },
  { key: 'monad-execution', label: 'EXEC' },
  { key: 'monad-rpc',       label: 'RPC'  },
];

// ─────────────────────────────────────────────────────────────────
// LOG EVENTS — aggregate WARN/ERROR from Loki, grouped by pattern.
// Complements NODE EVENTS (Prometheus counters). Some errors like
// "failed to find address for rebroadcast target" have no counter
// but do produce WARN lines — captured here.
// ─────────────────────────────────────────────────────────────────
interface LogEventGroup {
  patternId: string | null;
  label: string;
  count: number;
  action: 'none' | 'monitor' | 'investigate';
  note: string;
  service: string | null;
  example: string | null;
  lastSeen: number | null;
  services: Record<string, number>;
}
interface LogEventsResponse {
  range: string;
  total: number;
  unmatched: number;
  groups: LogEventGroup[];
  scannedSec?: number;
  clamped?: { requestedSec: number; note: string };
  error?: string;
}

// Renders as the 5th card inside NODE EVENTS, matching EventCategoryCard style.
// Source is journald (Loki) — complements the 4 Prometheus-metric categories.
function LogDerivedCategoryCard({
  range, customWindow, expanded, onToggle, filter, onlyWithEvents,
}: {
  range: RangeKey;
  customWindow: TimeWindow | null;
  expanded: boolean;
  onToggle: () => void;
  filter: string;
  onlyWithEvents: boolean;
}) {
  const [resp, setResp] = useState<LogEventsResponse | null>(null);
  const [err,  setErr]  = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      let url = '/api/node/log-events?';
      if (range === 'custom' && customWindow) {
        url += `start=${customWindow.start.getTime()}&end=${customWindow.end.getTime()}`;
      } else if (range !== 'custom') {
        url += `range=${range}`;
      } else return;
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json() as LogEventsResponse;
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResp(j);
    } catch (e) { setErr(String(e)); }
  }, [range, customWindow]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (range === 'custom') return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load, range]);

  const total = resp?.total ?? 0;
  const groups = resp?.groups ?? [];
  const q = filter.trim().toLowerCase();
  const filtered = groups
    .filter(g => !q || g.label.toLowerCase().includes(q) || (g.patternId ?? '').includes(q))
    .filter(g => !onlyWithEvents || g.count > 0);
  const color = total > 0 ? '#E05252' : 'var(--text-muted)';

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      background: 'rgba(255,255,255,0.01)', overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', padding: '12px 14px', background: 'transparent', border: 0,
          cursor: 'pointer', textAlign: 'left', color: 'inherit',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 11,
          color: 'var(--gold)', width: 10, flexShrink: 0, transition: 'transform 0.15s',
          display: 'inline-block',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}>
            Log-only events (journald)
          </span>
          <span style={{ fontSize: 10, color: 'rgba(138,136,112,0.7)' }}>
            WARN/ERROR without a Prometheus counter (e.g. rebroadcast target unreachable)
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 20, color }}>
              {total.toLocaleString('en-US')}
            </span>
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: 'var(--text-muted)' }}>
              {groups.length} group{groups.length === 1 ? '' : 's'}
            </span>
          </div>
          <span style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)' }}>
            source: journald via Loki
          </span>
        </div>
      </button>
      {expanded && (
        <div style={{
          padding: '8px 14px 12px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(0,0,0,0.25)',
        }}>
          {/* Only show error prominently if we have no data at all.
              When we do have cached data, show a small inline hint instead. */}
          {err && !resp && (
            <div style={{ fontSize: 11, color: '#E05252', padding: '8px 10px' }}>
              Error loading log events: {err}
            </div>
          )}
          {err && resp && (
            <div style={{
              fontSize: 10, color: 'rgba(232,160,32,0.8)',
              padding: '4px 10px', marginBottom: 6, fontStyle: 'italic',
            }}>
              (showing cached data — refresh failed: {err.slice(0, 80)})
            </div>
          )}
          {!resp && !err && (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              Loading…
            </div>
          )}
          {resp?.clamped && (
            <div style={{
              padding: '8px 10px', marginBottom: 8,
              border: '1px solid rgba(232,160,32,0.3)', borderRadius: 4,
              background: 'rgba(232,160,32,0.05)',
              fontSize: 10, color: '#E8A020',
              fontFamily: 'DM Mono, monospace', lineHeight: 1.5,
            }}>
              ⚠ {resp.clamped.note}
            </div>
          )}
          {resp && filtered.length === 0 && (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              {q || onlyWithEvents
                ? `No matching log groups (of ${groups.length})`
                : 'No WARN/ERROR events in this window.'}
            </div>
          )}
          {resp && filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map(g => {
                const gcolor = g.action === 'none'
                  ? 'rgba(138,136,112,0.7)'
                  : g.action === 'monitor' ? '#E8A020' : '#E05252';
                const icon = g.action === 'none' ? 'ℹ' : g.action === 'monitor' ? '⚠' : '✕';
                const key = g.patternId ?? '__other';
                const open = expandedId === key;
                return (
                  <div key={key} style={{
                    borderRadius: 4,
                    background: g.action !== 'none' ? 'rgba(224,82,82,0.05)' : 'transparent',
                  }}>
                    <button
                      onClick={() => setExpandedId(open ? null : key)}
                      style={{
                        width: '100%', background: 'transparent', border: 0, cursor: 'pointer',
                        padding: '6px 8px', textAlign: 'left', color: 'inherit',
                        display: 'grid', gridTemplateColumns: '14px 18px 1fr 80px 100px',
                        gap: 12, alignItems: 'center',
                      }}
                    >
                      <span style={{
                        fontFamily: 'DM Mono, monospace', fontSize: 9,
                        color: 'var(--text-muted)', opacity: 0.7,
                        transition: 'transform 0.15s',
                        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                        display: 'inline-block',
                      }}>▸</span>
                      <span style={{ color: gcolor, fontSize: 13 }}>{icon}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{
                          fontSize: 12, color: g.count > 0 ? 'var(--text)' : 'var(--text-muted)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {g.label}
                        </span>
                        <span style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)', fontFamily: 'DM Mono, monospace' }}>
                          {g.patternId ?? 'unknown'}{g.service ? ` · ${g.service}` : ''}
                        </span>
                      </div>
                      <span style={{
                        fontFamily: 'DM Mono, monospace', fontSize: 14,
                        color: g.count > 0 ? gcolor : 'var(--text-muted)',
                        textAlign: 'right',
                      }}>
                        {g.count > 0 ? `×${g.count.toLocaleString('en-US')}` : '0'}
                      </span>
                      <span style={{
                        fontFamily: 'DM Mono, monospace', fontSize: 10,
                        color: 'rgba(138,136,112,0.6)', textAlign: 'right',
                      }}>
                        {g.lastSeen ? new Date(g.lastSeen).toLocaleTimeString('ru-RU',{hour12:false}) : '—'}
                      </span>
                    </button>
                    {open && (
                      <div style={{
                        padding: '10px 14px 12px 34px',
                        borderTop: '1px solid rgba(201,168,76,0.06)',
                        fontSize: 11, color: 'var(--text-muted)',
                      }}>
                        <div style={{
                          marginBottom: 12, padding: '8px 10px',
                          border: `1px solid ${g.action === 'none' ? 'rgba(138,136,112,0.15)' : gcolor + '40'}`,
                          borderRadius: 4, background: 'rgba(0,0,0,0.3)',
                        }}>
                          <div style={{
                            display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4,
                            fontSize: 9, letterSpacing: '0.08em',
                          }}>
                            <span style={{ color: gcolor, fontSize: 12 }}>{icon}</span>
                            <span style={{ color: gcolor, fontWeight: 600 }}>
                              {g.action === 'none' ? 'NO ACTION NEEDED'
                                : g.action === 'monitor' ? 'MONITOR' : 'INVESTIGATE'}
                            </span>
                          </div>
                          <div style={{
                            fontSize: 11, color: 'var(--text)', lineHeight: 1.5,
                            fontFamily: 'DM Mono, monospace',
                          }}>
                            {g.note}
                          </div>
                        </div>
                        {g.example && (
                          <div style={{
                            padding: '6px 10px', marginBottom: 8,
                            background: 'rgba(0,0,0,0.55)',
                            border: '1px solid rgba(201,168,76,0.08)', borderRadius: 4,
                            fontSize: 10, fontFamily: 'DM Mono, monospace',
                            color: 'rgba(200,200,180,0.75)',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          }}>
                            <div style={{
                              fontSize: 9, letterSpacing: '0.08em', marginBottom: 3,
                              color: 'rgba(138,136,112,0.5)',
                            }}>
                              EXAMPLE LOG LINE · last seen {g.lastSeen ? new Date(g.lastSeen).toLocaleTimeString('ru-RU',{hour12:false}) : '—'}
                            </div>
                            {g.example}
                          </div>
                        )}
                        <div style={{
                          fontSize: 10, color: 'rgba(138,136,112,0.6)',
                          fontFamily: 'DM Mono, monospace',
                        }}>
                          {Object.entries(g.services).map(([svc, n]) => (
                            <span key={svc} style={{ marginRight: 12 }}>{svc}: {n}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogPanel({ range, customWindow }: { range: RangeKey; customWindow: TimeWindow | null }) {
  const [open, setOpen]           = useState(false);
  const [level, setLevel]         = useState<LogLevel>('WARN');
  const [svc,   setSvc]           = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery]         = useState('');
  const [resp,  setResp]          = useState<LogsResponse | null>(null);
  const [busy,  setBusy]          = useState(false);

  const loadLogs = useCallback(async (
    r: RangeKey, cw: TimeWindow | null, l: LogLevel, s: string, q: string,
  ) => {
    setBusy(true);
    try {
      let url: string;
      if (r === 'custom' && cw) {
        url = `/api/node/logs?start=${cw.start.getTime()}&end=${cw.end.getTime()}&level=${l}&limit=300`;
      } else if (r !== 'custom') {
        url = `/api/node/logs?range=${r}&level=${l}&limit=300`;
      } else {
        setBusy(false); return; // custom selected but window not applied yet
      }
      if (s) url += `&service=${encodeURIComponent(s)}`;
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const res = await window.fetch(url, { cache: 'no-store' });
      const json = await res.json() as LogsResponse;
      setResp(res.ok ? json : { logs: [], range: r, count: 0, error: json.error || `HTTP ${res.status}` });
    } catch (e) {
      setResp({ logs: [], range: r, count: 0, error: String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  // Only fetch when open
  useEffect(() => {
    if (open) loadLogs(range, customWindow, level, svc, query);
  }, [open, range, customWindow, level, svc, query, loadLogs]);

  useEffect(() => {
    if (!open || range === 'custom') return; // don't poll custom windows
    const t = setInterval(() => loadLogs(range, null, level, svc, query), POLL_INTERVAL);
    return () => clearInterval(t);
  }, [open, range, level, svc, query, loadLogs]);

  const warnCount = resp?.logs.filter(l => l.level === 'WARN' || l.level === 'ERROR' || l.level === 'FATAL').length ?? 0;

  return (
    <div className="card" style={{ padding: '0', marginBottom: 24, overflow: 'hidden' }}>
      {/* Collapsible header */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', background: 'transparent', border: 0, cursor: 'pointer',
          padding: '14px 24px', textAlign: 'left', color: 'inherit',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <span style={{
          fontFamily: 'DM Mono, monospace', fontSize: 10, color: 'var(--gold)',
          transition: 'transform 0.15s', display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        <span style={{
          fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em',
          color: 'var(--gold)', flex: 1,
        }}>
          NODE LOGS
        </span>
        {busy && <span style={{ fontSize: 10, color: 'rgba(138,136,112,0.45)' }}>loading…</span>}
        {!open && resp && resp.count > 0 && (
          <span style={{
            fontSize: 10, fontFamily: 'DM Mono, monospace',
            color: warnCount > 0 ? '#E8A020' : 'rgba(138,136,112,0.6)',
            letterSpacing: '0.04em',
          }}>
            {resp.count} {level}+ in {range}
          </span>
        )}
      </button>

      {open && <div style={{ padding: '0 24px 20px' }}>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        {/* Level buttons */}
        <div style={{ display: 'flex', gap: 3 }}>
          {LOG_LEVELS.map(l => {
            const active = level === l;
            const c = LOG_LEVEL_COLOR[l];
            return (
              <button
                key={l}
                onClick={() => setLevel(l)}
                style={{
                  padding: '3px 9px',
                  fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.04em',
                  background: active ? c : 'transparent',
                  color: active ? '#000' : c,
                  border: `1px solid ${c}`,
                  borderRadius: 4, cursor: 'pointer',
                  opacity: active ? 1 : 0.6,
                  transition: 'all 0.15s',
                }}
              >
                {l}+
              </button>
            );
          })}
        </div>

        <div style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />

        {/* Service buttons */}
        <div style={{ display: 'flex', gap: 3 }}>
          {LOG_SERVICES.map(s => {
            const active = svc === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setSvc(s.key)}
                style={{
                  padding: '3px 9px',
                  fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.04em',
                  background: active ? 'var(--gold)' : 'transparent',
                  color: active ? '#000' : 'var(--text-muted)',
                  border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                  borderRadius: 4, cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <div style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />

        {/* Search */}
        <form
          onSubmit={e => { e.preventDefault(); setQuery(queryInput.trim()); }}
          style={{ display: 'flex', gap: 4, flex: 1, minWidth: 150 }}
        >
          <input
            type="text"
            placeholder="regex filter… (Enter)"
            value={queryInput}
            onChange={e => setQueryInput(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '3px 10px', fontSize: 11,
              color: 'var(--text)', outline: 'none',
              fontFamily: 'DM Mono, monospace',
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setQueryInput(''); }}
              style={{
                padding: '3px 9px',
                fontFamily: 'DM Mono, monospace', fontSize: 11,
                background: 'transparent', color: '#E05252',
                border: '1px solid rgba(224,82,82,0.3)',
                borderRadius: 6, cursor: 'pointer',
              }}
            >
              ×
            </button>
          )}
        </form>
      </div>

      <LogsView resp={resp} header={`LOG MESSAGES (${level}+ · ${svc || 'all'}${query ? ` · "${query}"` : ''})`} maxHeight={400} />
      </div>}
    </div>
  );
}

const SERVICE_STATE_COLOR: Record<ServiceStatus, { dot: string; bg: string; fg: string; label: string }> = {
  running: { dot: '#4CAF6E', bg: 'rgba(76,175,110,0.08)', fg: '#4CAF6E', label: 'RUNNING' },
  stale:   { dot: '#C9A84C', bg: 'rgba(201,168,76,0.08)', fg: '#C9A84C', label: 'STALE'   },
  stopped: { dot: '#E05252', bg: 'rgba(224,82,82,0.08)',  fg: '#E05252', label: 'STOPPED' },
};

function fmtUptime(sec: number): string {
  if (!sec || !isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ServiceCard({ service }: { service: ServiceInfo }) {
  const sc = SERVICE_STATE_COLOR[service.status];
  const signals: Array<[string, string]> = [];
  const sig = service.signals;
  if (service.key === 'monad') {
    if (sig.uptimeSec) signals.push(['uptime', fmtUptime(sig.uptimeSec)]);
    if (sig.peers != null) signals.push(['peers', sig.peers.toLocaleString('en-US')]);
  } else if (service.key === 'monad-execution') {
    if (sig.block) signals.push(['block', `#${sig.block.toLocaleString('en-US')}`]);
    if (sig.commits) signals.push(['commits', sig.commits.toLocaleString('en-US')]);
  } else if (service.key === 'monad-bft') {
    if (sig.rounds) signals.push(['rounds', sig.rounds.toLocaleString('en-US')]);
    if (sig.votes) signals.push(['votes', sig.votes.toLocaleString('en-US')]);
    if (sig.commits) signals.push(['commits', sig.commits.toLocaleString('en-US')]);
  } else if (service.key === 'monad-rpc') {
    signals.push(['active', (sig.activeRequests ?? 0).toLocaleString('en-US')]);
    if (sig.totalRequests) signals.push(['req total', sig.totalRequests.toLocaleString('en-US')]);
  }
  return (
    <div style={{
      border: `1px solid ${sc.fg === '#4CAF6E' ? 'rgba(76,175,110,0.25)' : sc.fg === '#C9A84C' ? 'rgba(201,168,76,0.3)' : 'rgba(224,82,82,0.25)'}`,
      borderRadius: 8,
      background: sc.bg,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: sc.dot,
            boxShadow: service.status === 'running' ? `0 0 8px ${sc.dot}` : 'none',
            animation: service.status === 'running' ? 'pulse 2s infinite' : 'none',
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'DM Mono, monospace', fontSize: 13, color: 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {service.label}
          </span>
        </div>
        <span style={{
          fontSize: 9, letterSpacing: '0.1em', color: sc.fg,
          fontFamily: 'Bebas Neue, sans-serif', flexShrink: 0,
        }}>
          {sc.label}
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'rgba(138,136,112,0.7)', lineHeight: 1.4 }}>
        {service.description}
      </div>
      {signals.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, color: 'var(--text-muted)' }}>
          {signals.map(([k, v]) => (
            <span key={k} style={{ fontFamily: 'DM Mono, monospace' }}>
              <span style={{ opacity: 0.7 }}>{k}</span> <span style={{ color: 'var(--text)' }}>{v}</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 9, color: 'rgba(138,136,112,0.5)' }}>
        {service.metricsCount > 0
          ? `${service.metricsCount} metrics · last sample ${service.ageSec != null ? `${service.ageSec}s ago` : '—'}`
          : 'no metrics in prefix — service likely not running'}
      </div>
    </div>
  );
}
