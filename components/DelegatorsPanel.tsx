'use client';
import { useEffect, useState } from 'react';

interface Delegator {
  delegator: string;
  totalMon: number;
  opCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
}
interface RecentOp {
  blockNumber: number;
  timeMs: number;
  selector: string;
  delegator: string;
  target: string;
  amountMon: number;
}
interface Resp {
  target: string;
  range: string;
  delegatorCount: number;
  totalMon: number;
  opCount: number;
  delegators: Delegator[];
  recentOps: RecentOp[];
}

type Range = '1h' | '6h' | '24h' | '7d' | '30d';
const RANGES: Range[] = ['1h', '6h', '24h', '7d', '30d'];

function shortAddr(a: string) { return `${a.slice(0, 10)}…${a.slice(-6)}`; }

function fmtAge(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

/**
 * Shows delegation activity targeting a specific validator address.
 *
 * IMPORTANT: on Monad testnet the staking-tx payload (20-byte target) does not
 * always equal the validator's authAddress — it's a signing-level identifier
 * we haven't fully mapped yet. Empty results are normal on testnet; the panel
 * is mainnet-ready and will populate once delegations flow to this address.
 */
export default function DelegatorsPanel({ address }: { address: string }) {
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/delegators?target=${address.toLowerCase()}&range=${range}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as Resp;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [address, range]);

  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, letterSpacing: '0.08em', color: 'var(--gold)' }}>
            DELEGATIONS
          </span>
          {data && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {data.delegatorCount} delegators · {data.totalMon.toLocaleString('en-US', { maximumFractionDigits: 0 })} MON · {data.opCount} operations
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => {
            const active = range === r;
            return (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '3px 9px',
                  fontFamily: 'DM Mono, monospace', fontSize: 10,
                  letterSpacing: '0.05em',
                  background: active ? 'var(--gold)' : 'transparent',
                  color: active ? '#000' : 'var(--text-muted)',
                  border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Loading…
        </div>
      ) : err ? (
        <div style={{ padding: 20, fontSize: 12, color: '#E05252' }}>{err}</div>
      ) : !data || data.delegators.length === 0 ? (
        <div style={{
          padding: '18px 20px', fontSize: 12, color: 'var(--text-muted)',
          border: '1px dashed rgba(201,168,76,0.15)', borderRadius: 6, lineHeight: 1.5,
        }}>
          No delegation activity observed targeting this address in the selected window.
          <br />
          <span style={{ fontSize: 11, color: 'rgba(138,136,112,0.65)' }}>
            Note: on Monad testnet the staking-tx payload is a signing-level identifier and
            doesn&apos;t always equal a validator&apos;s authAddress. If this validator has an
            associated signing key, delegations under that key won&apos;t appear here.
          </span>
        </div>
      ) : (
        <>
          {/* Top delegators table */}
          <div style={{ overflowX: 'auto', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={th}>#</th>
                  <th style={th}>DELEGATOR</th>
                  <th style={{ ...th, textAlign: 'right' }}>TOTAL MON</th>
                  <th style={{ ...th, textAlign: 'right' }}>OPS</th>
                  <th style={{ ...th, textAlign: 'right' }}>FIRST SEEN</th>
                  <th style={{ ...th, textAlign: 'right' }}>LAST SEEN</th>
                </tr>
              </thead>
              <tbody>
                {data.delegators.map((d, i) => (
                  <tr key={d.delegator} style={{ borderBottom: '1px solid rgba(201,168,76,0.04)' }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={td}>
                      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--gold)' }}>
                        {shortAddr(d.delegator)}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text)', fontFamily: 'DM Mono, monospace' }}>
                      {d.totalMon.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
                      {d.opCount}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>
                      {fmtAge(d.firstSeenMs)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>
                      {fmtAge(d.lastSeenMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recent ops feed */}
          {data.recentOps.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.06em' }}>
                RECENT OPERATIONS (latest {Math.min(20, data.recentOps.length)})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 240, overflowY: 'auto' }}>
                {data.recentOps.slice(0, 20).map((op, i) => (
                  <div key={i} style={{
                    display: 'grid',
                    gridTemplateColumns: '80px 1fr 110px 60px',
                    gap: 8, alignItems: 'center',
                    fontFamily: 'DM Mono, monospace', fontSize: 10,
                    padding: '4px 6px',
                    borderBottom: '1px solid rgba(201,168,76,0.03)',
                  }}>
                    <span style={{ color: 'var(--text-muted)' }}>#{op.blockNumber}</span>
                    <span style={{ color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {shortAddr(op.delegator)}
                    </span>
                    <span style={{ color: 'var(--text)', textAlign: 'right' }}>
                      {op.amountMon.toFixed(2)} MON
                    </span>
                    <span style={{ color: 'var(--text-muted)', textAlign: 'right', fontSize: 9 }}>
                      {fmtAge(op.timeMs)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        Source: <strong style={{ color: 'var(--text)' }}>monad_staking_ops</strong> — transactions targeting the staking precompile (<code>0x…1000</code>),
        scanned incrementally and persisted to InfluxDB since the dashboard&apos;s last cold start.
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  fontSize: 10, fontWeight: 500, letterSpacing: '0.08em',
  color: 'var(--text-muted)', textTransform: 'uppercase',
  padding: '8px 10px', textAlign: 'left',
};
const td: React.CSSProperties = {
  fontSize: 12, padding: '8px 10px', whiteSpace: 'nowrap',
};
