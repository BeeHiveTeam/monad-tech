'use client';
import { useEffect, useState } from 'react';

interface Delegator {
  address: string;
  stakeMon: number;
}
interface Resp {
  validatorId: number;
  address: string;
  moniker: string | null;
  delegatorCount: number;
  totalStakeMon: number;
  truncated: boolean;
  delegators: Delegator[];
}

function shortAddr(a: string) { return `${a.slice(0, 10)}…${a.slice(-6)}`; }

export default function DelegatorsPanel({ address }: { address: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/validator-delegators?address=${address.toLowerCase()}`);
        if (!r.ok) {
          if (r.status === 404) { setErr(null); setData(null); return; }
          throw new Error(`HTTP ${r.status}`);
        }
        const j = await r.json() as Resp;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [address]);

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
              {data.delegatorCount} delegators · {data.totalStakeMon.toLocaleString('en-US', { maximumFractionDigits: 0 })} MON
              {data.truncated && ' · top 200 shown'}
            </span>
          )}
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
          No delegators found for this validator.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={th}>#</th>
                <th style={th}>DELEGATOR</th>
                <th style={{ ...th, textAlign: 'right' }}>STAKE (MON)</th>
                <th style={{ ...th, textAlign: 'right' }}>SHARE</th>
              </tr>
            </thead>
            <tbody>
              {data.delegators.map((d, i) => {
                const pct = data.totalStakeMon > 0 ? (d.stakeMon / data.totalStakeMon) * 100 : 0;
                return (
                  <tr key={d.address} style={{ borderBottom: '1px solid rgba(201,168,76,0.04)' }}>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={td}>
                      <a
                        href={`/address/${d.address}`}
                        style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}
                      >
                        {shortAddr(d.address)}
                      </a>
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text)', fontFamily: 'DM Mono, monospace' }}>
                      {d.stakeMon.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
                      {pct.toFixed(pct < 1 ? 3 : 1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        Source: <strong style={{ color: 'var(--text)' }}>staking precompile</strong> (<code>0x…1000</code>) — current on-chain delegator state via <code>getDelegators</code> + <code>getDelegator</code>. Cached 60s.
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
