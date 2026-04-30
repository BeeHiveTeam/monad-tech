'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ContractRow {
  address: string;
  blocks: number;
  retried: number;
  retriedShare: number;
  avgRtp: number;
  tx: number;
}

interface ApiResponse {
  window: string;
  windowSeconds: number;
  blocksAnalyzed: number;
  totalTx: number;
  fetchedAt: number;
  rows: ContractRow[];
}

type Window = '5m' | '15m' | '1h';

const WINDOW_LABELS: Window[] = ['5m', '15m', '1h'];
// Per-window default `min` — must mirror lib/topContracts WINDOW_DEFAULT_MIN
// so the API returns the InfluxDB-cached snapshot path (instant) for the
// default UI selection. Custom min via the picker falls through to live compute.
const WINDOW_DEFAULT_MIN: Record<Window, number> = { '5m': 20, '15m': 50, '1h': 100 };
const MIN_OPTIONS = [10, 20, 50, 100];

function shareColor(pct: number): string {
  if (pct >= 75) return '#E05252';
  if (pct >= 50) return '#E8A020';
  if (pct >= 25) return '#C9A84C';
  return '#4CAF6E';
}

function Copyable({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      onClick={() => {
        navigator.clipboard.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        fontFamily: 'DM Mono, monospace',
        fontSize: 11,
        color: copied ? '#4CAF6E' : 'var(--text)',
        cursor: 'pointer',
        transition: 'color 0.15s',
      }}
      title={copied ? 'copied!' : `click to copy ${address}`}
    >
      {address.slice(0, 10)}…{address.slice(-6)}
    </span>
  );
}

export default function TopContractsTable({ network }: { network: 'testnet' | 'mainnet' }) {
  // Default 5m: fully covered by WS ring → 0 RPC fallback → instant.
  // 15m+ may take 25-30s on cold cache when blocks fall outside the ring;
  // background warmup poller in instrumentation.ts keeps cache warm afterwards.
  const [win, setWin] = useState<Window>('5m');
  const [min, setMin] = useState<number>(WINDOW_DEFAULT_MIN['5m']);

  // Reset min to the new window's default whenever the window changes.
  useEffect(() => { setMin(WINDOW_DEFAULT_MIN[win]); }, [win]);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const r = await fetch(
          `/api/top-contracts?network=${network}&window=${win}&min=${min}&limit=20`,
          { cache: 'no-store' },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as ApiResponse;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [win, min, network]);

  // Internal /address page — see app/address/[address]/page.tsx. Network
  // parameter passes through so the address API knows which RPC to query.
  const internalAddrBase = `/address`;

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 10, marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, letterSpacing: '0.08em', color: 'var(--gold)' }}>
            TOP CONTRACTS BY RETRY RATE
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            parallelism-conflict hotspots
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>WINDOW</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {WINDOW_LABELS.map(w => (
              <button
                key={w}
                onClick={() => setWin(w)}
                style={{
                  padding: '3px 9px',
                  fontFamily: 'DM Mono, monospace', fontSize: 10, letterSpacing: '0.05em',
                  background: w === win ? 'var(--gold)' : 'transparent',
                  color: w === win ? '#000' : 'var(--text-muted)',
                  border: `1px solid ${w === win ? 'var(--gold)' : 'var(--border)'}`,
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {w}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginLeft: 6 }}>MIN BLOCKS</span>
          <select
            value={min}
            onChange={e => setMin(+e.target.value)}
            style={{
              background: 'var(--surface2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '3px 6px',
              fontFamily: 'DM Mono, monospace',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {MIN_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Summary */}
      {data && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          {data.blocksAnalyzed.toLocaleString()} blocks · {data.totalTx.toLocaleString()} tx analyzed ·
          {' '}showing top {data.rows.length} contracts
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        {loading && !data ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Aggregating blocks…
          </div>
        ) : err ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#E05252', fontSize: 12 }}>
            {err}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            No contracts match the current filters.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle}>#</th>
                <th style={thStyle}>CONTRACT</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>BLOCKS</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>RETRIED</th>
                <th style={{ ...thStyle, textAlign: 'left', minWidth: 140 }}>RETRIED RATIO</th>
                <th
                  style={{ ...thStyle, textAlign: 'right', cursor: 'help' }}
                  title="Co-occurrence retry-percentage. Average of block-level rtp across blocks containing this contract. Block-level rtp is shared by ALL contracts in the same block, so high values indicate correlation with retried blocks — not proof this contract caused them."
                >
                  CO-OCC RTP
                </th>
                <th style={{ ...thStyle, textAlign: 'right' }}>TX</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.address} style={{ borderBottom: '1px solid rgba(201,168,76,0.04)' }}>
                  <td style={{ ...tdStyle, color: 'var(--text-muted)', width: 28 }}>{i + 1}</td>
                  <td style={tdStyle}><Copyable address={r.address} /></td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text)' }}>{r.blocks}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: shareColor(r.retriedShare) }}>
                    {r.retried}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        flex: 1, height: 6, background: 'rgba(201,168,76,0.08)',
                        borderRadius: 3, minWidth: 80, overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${r.retriedShare}%`, height: '100%',
                          background: shareColor(r.retriedShare),
                          transition: 'width 0.3s',
                        }} />
                      </div>
                      <span style={{
                        fontFamily: 'DM Mono, monospace', fontSize: 10,
                        color: shareColor(r.retriedShare), width: 40, textAlign: 'right',
                      }}>
                        {r.retriedShare.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: shareColor(r.avgRtp), fontFamily: 'DM Mono, monospace' }}>
                    {r.avgRtp.toFixed(1)}%
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)' }}>{r.tx}</td>
                  <td style={tdStyle}>
                    <Link
                      href={`${internalAddrBase}/${r.address}`}
                      style={{
                        fontSize: 10, color: 'var(--gold-dim)', textDecoration: 'none',
                        fontFamily: 'DM Mono, monospace',
                      }}
                      title="view contract details"
                    >
                      →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text)' }}>Retried ratio</strong> = % of blocks containing this contract that had at least one re-executed tx.{' '}
        <strong style={{ color: 'var(--text)' }}>Co-occ rtp</strong> = average block-level rtp across those blocks — shared by every contract in the same block, so it&apos;s a co-occurrence signal, not per-contract retry rate. Hot contracts concentrate at the top by correlation. System addresses (precompiles, e.g. <code>0x…1000</code>) are filtered out.
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  padding: '10px 10px',
  textAlign: 'left',
};

const tdStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '8px 10px',
  whiteSpace: 'nowrap',
};
