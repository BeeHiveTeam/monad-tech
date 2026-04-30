'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Severity = 'info' | 'warn' | 'critical';
type IncidentType =
  | 'reorg'
  | 'validator_removed' | 'validator_added' | 'stake_decrease'
  | 'retry_spike' | 'block_stall'
  | 'critical_log'
  | 'state_root_mismatch' | 'state_sync_active'
  | 'consensus_stress' | 'vote_delay_high' | 'tip_lag' | 'exec_lag';

interface Incident {
  id: string;
  ts: number;
  severity: Severity;
  type: IncidentType;
  title: string;
  detail: string;
  blockNumber?: number;
  address?: string;
  service?: string;
  meta?: Record<string, unknown>;
}

interface ApiResponse {
  range: string;
  fetchedAt: number;
  windowSeconds: number;
  counts: Record<Severity, number>;
  byType: Record<IncidentType, number>;
  incidents: Incident[];
}

type Range = '1h' | '6h' | '12h' | '24h' | '7d';

const RANGES: Range[] = ['1h', '6h', '12h', '24h', '7d'];
const SEVERITIES: Array<Severity | 'all'> = ['all', 'critical', 'warn', 'info'];

const SEV_COLOR: Record<Severity, string> = {
  critical: '#E05252',
  warn: '#E8A020',
  info: '#5B8FB9',
};
const SEV_BG: Record<Severity, string> = {
  critical: 'rgba(224,82,82,0.08)',
  warn: 'rgba(232,160,32,0.08)',
  info: 'rgba(91,143,185,0.08)',
};

// Monospaced symbol per incident type — cheap but distinctive.
const TYPE_ICON: Record<IncidentType, string> = {
  reorg: '↺',
  validator_removed: '×',
  validator_added: '+',
  stake_decrease: '↓',
  retry_spike: '↯',
  block_stall: '⏸',
  critical_log: '!',
  state_root_mismatch: '⊗',
  state_sync_active: '⟳',
  consensus_stress: '⚡',
  vote_delay_high: '⏱',
  tip_lag: '↧',
  exec_lag: '⌫',
};

const TYPE_LABEL: Record<IncidentType, string> = {
  reorg: 'Reorg',
  validator_removed: 'Validator removed',
  validator_added: 'Validator added',
  stake_decrease: 'Stake decrease',
  retry_spike: 'Retry spike',
  block_stall: 'Block stall',
  critical_log: 'Critical log',
  state_root_mismatch: 'State root mismatch',
  state_sync_active: 'State sync',
  consensus_stress: 'Consensus stress',
  vote_delay_high: 'Vote delay high',
  tip_lag: 'Tip lag',
  exec_lag: 'Execution lag',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { hour12: false });
}

function fmtAge(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export default function IncidentTimeline() {
  const [range, setRange] = useState<Range>('6h');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const q = new URLSearchParams({ range });
        if (severity !== 'all') q.set('severity', severity);
        const r = await fetch(`/api/incidents?${q.toString()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as ApiResponse;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [range, severity]);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 12,
          flexWrap: 'wrap', marginBottom: 4,
        }}>
          <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: '0.08em', color: 'var(--gold)' }}>
            INCIDENT TIMELINE
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            reorgs · validator churn · retry spikes · block stalls · critical logs · state root · state sync · consensus stress · vote delay · tip lag
          </span>
        </div>
        {data && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {data.incidents.length} events in last {range} ·
            {' '}<span style={{ color: SEV_COLOR.critical }}>{data.counts.critical} critical</span> ·
            {' '}<span style={{ color: SEV_COLOR.warn }}>{data.counts.warn} warn</span> ·
            {' '}<span style={{ color: SEV_COLOR.info }}>{data.counts.info} info</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        flexWrap: 'wrap', marginBottom: 14, paddingBottom: 14,
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '4px 10px',
                fontFamily: 'DM Mono, monospace', fontSize: 10,
                letterSpacing: '0.05em',
                background: r === range ? 'var(--gold)' : 'transparent',
                color: r === range ? '#000' : 'var(--text-muted)',
                border: `1px solid ${r === range ? 'var(--gold)' : 'var(--border)'}`,
                borderRadius: 4, cursor: 'pointer',
              }}
            >
              {r}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {SEVERITIES.map(s => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              style={{
                padding: '4px 10px',
                fontFamily: 'DM Mono, monospace', fontSize: 10,
                letterSpacing: '0.05em', textTransform: 'uppercase',
                background: s === severity
                  ? (s === 'all' ? 'var(--gold)' : SEV_COLOR[s as Severity])
                  : 'transparent',
                color: s === severity ? '#000' : 'var(--text-muted)',
                border: `1px solid ${s === severity
                  ? (s === 'all' ? 'var(--gold)' : SEV_COLOR[s as Severity])
                  : 'var(--border)'}`,
                borderRadius: 4, cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      {err ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#E05252', fontSize: 12 }}>
          {err}
        </div>
      ) : loading && !data ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Scanning sources…
        </div>
      ) : !data || data.incidents.length === 0 ? (
        <div style={{
          padding: '30px 20px', textAlign: 'center',
          fontSize: 13, color: 'var(--text-muted)',
          border: '1px dashed rgba(201,168,76,0.15)', borderRadius: 6,
        }}>
          <span style={{ color: '#4CAF6E', fontSize: 15 }}>●</span>
          <span style={{ marginLeft: 8 }}>No incidents in this window — network is healthy.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.incidents.map(i => {
            const isOpen = expanded.has(i.id);
            return (
              <div
                key={i.id}
                onClick={() => toggle(i.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px 90px 1fr auto',
                  gap: 12, alignItems: 'start', padding: '10px 12px',
                  background: SEV_BG[i.severity],
                  border: `1px solid ${SEV_COLOR[i.severity]}33`,
                  borderLeft: `3px solid ${SEV_COLOR[i.severity]}`,
                  borderRadius: 6, cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                {/* Icon */}
                <span style={{
                  fontSize: 14, color: SEV_COLOR[i.severity],
                  fontFamily: 'DM Mono, monospace', lineHeight: 1.4,
                }}>
                  {TYPE_ICON[i.type]}
                </span>

                {/* Type chip + age */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{
                    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: SEV_COLOR[i.severity], fontWeight: 500,
                  }}>
                    {TYPE_LABEL[i.type]}
                  </span>
                  <span style={{
                    fontSize: 10, color: 'var(--text-muted)',
                    fontFamily: 'DM Mono, monospace',
                  }}>
                    {fmtAge(i.ts)}
                  </span>
                </div>

                {/* Title + (optional) detail */}
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, color: 'var(--text)', lineHeight: 1.4,
                    wordBreak: 'break-word',
                  }}>
                    {i.title}
                  </div>
                  {isOpen && (
                    <div style={{
                      marginTop: 6, fontSize: 11, color: 'var(--text-muted)',
                      lineHeight: 1.5, wordBreak: 'break-word',
                    }}>
                      <div>{i.detail}</div>
                      {(i.blockNumber || i.address || i.service) && (
                        <div style={{
                          marginTop: 6, display: 'flex', gap: 12,
                          flexWrap: 'wrap', fontFamily: 'DM Mono, monospace',
                          fontSize: 10,
                        }}>
                          {i.blockNumber && (
                            <Link
                              href={`/block/${i.blockNumber}`}
                              style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}
                            >
                              block: {i.blockNumber}
                            </Link>
                          )}
                          {i.address && (
                            <Link
                              href={`/address/${i.address}`}
                              style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}
                              title={i.address}
                            >
                              addr: {i.address.slice(0, 8)}…{i.address.slice(-4)}
                            </Link>
                          )}
                          {i.service && <span>service: {i.service}</span>}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Time */}
                <span style={{
                  fontSize: 10, color: 'var(--text-muted)',
                  fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap',
                }}>
                  {fmtTime(i.ts)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
        Sources: <strong>reorgs</strong> + <strong>validator churn</strong> + <strong>node anomalies</strong> (InfluxDB persisted) ·
        {' '}<strong>retry spikes</strong> + <strong>block stalls</strong> (Loki, last 15min only for wider ranges) ·
        {' '}<strong>critical logs</strong> (ERROR/FATAL from monad-execution & monad-bft).
        {' '}Anomaly detectors poll Prometheus every 30s for state-root mismatches, state-sync transitions,
        TC ratio (consensus stress), vote-delay p99, and local-vs-reference RPC tip lag.
      </div>
    </div>
  );
}
