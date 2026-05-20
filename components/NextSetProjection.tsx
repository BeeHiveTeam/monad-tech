'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Phase = 'post-rotation' | 'active' | 'pre-snapshot' | 'unknown';

interface SetMember {
  validatorId: number;
  authAddress: string;
  moniker: string | null;
  snapshotStakeMon: number;
  activeStakeMon: number;
  consensusStakeMon: number;
  deltaMon: number;
  deltaPct: number;
}

interface NextSetData {
  network: string;
  fetchedAt: number;
  building?: boolean;
  epoch: {
    currentEpoch: number;
    blockInEpoch: number;
    blocksPerEpoch: number;
    blocksUntilNext: number;
    progressPct: number;
  } | null;
  phase: Phase;
  currentSetSize: number;
  projectedSetSize: number;
  joining: SetMember[];
  leaving: SetMember[];
  movers: SetMember[];
  thresholds: { moveMon: number; movePct: number };
}

function fmtStake(mon: number): string {
  if (Math.abs(mon) >= 1_000_000) return `${(mon / 1_000_000).toFixed(2)}M`;
  if (Math.abs(mon) >= 1_000) return `${(mon / 1_000).toFixed(1)}K`;
  return mon.toFixed(0);
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

const PHASE_STYLE: Record<Phase, { bg: string; fg: string; label: string; hint: string }> = {
  'active':        { bg: 'rgba(76,175,110,0.14)',  fg: '#4CAF6E', label: 'ACTIVE PHASE',
                     hint: 'Normal operation. Stake changes affect the *next* snapshot.' },
  'pre-snapshot':  { bg: 'rgba(201,168,76,0.14)',  fg: '#C9A84C', label: 'PRE-SNAPSHOT',
                     hint: 'Snapshot window is near. Delegations finalized after the cutoff carry into the next epoch.' },
  'post-rotation': { bg: 'rgba(76,175,110,0.10)',  fg: '#4CAF6E', label: 'POST-ROTATION',
                     hint: 'New active set just took over. Stake views are realigning.' },
  'unknown':       { bg: 'rgba(138,136,112,0.14)', fg: '#8A8870', label: 'UNKNOWN', hint: '' },
};

export default function NextSetProjection({ network }: { network: string }) {
  const [data, setData] = useState<NextSetData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/network/next-set?network=${network}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [network]);

  if (loading || !data) {
    return (
      <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>
        Loading next-set projection…
      </div>
    );
  }
  if (data.building) {
    return (
      <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>
        Validator registry is still loading. Refresh in a few seconds.
      </div>
    );
  }

  const phase = PHASE_STYLE[data.phase];

  return (
    <div className="card" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 16, color: 'var(--gold)', letterSpacing: '0.08em' }}>
            Next-Set Projection
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxWidth: 620 }}>
            Who joins / leaves / moves at the next epoch rotation, projected from
            <strong> snapshotStake (slot 8)</strong>. The set is fixed when the snapshot is taken at epoch end; this is the answer to "why is my dashboard stake different from my wallet?"
          </div>
        </div>
        <div style={{
          padding: '6px 12px', borderRadius: 12,
          background: phase.bg, color: phase.fg,
          fontSize: 11, letterSpacing: '0.08em',
          border: `1px solid ${phase.fg}33`,
          alignSelf: 'flex-start',
        }} title={phase.hint}>
          {phase.label}
        </div>
      </div>

      {data.epoch && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
          Epoch <strong style={{ color: 'var(--gold)' }}>#{data.epoch.currentEpoch}</strong> · block {data.epoch.blockInEpoch.toLocaleString()} / {data.epoch.blocksPerEpoch.toLocaleString()} ({data.epoch.progressPct.toFixed(1)}%) · <strong>{data.epoch.blocksUntilNext.toLocaleString()} blocks until rotation</strong>
        </div>
      )}

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Tile label="Current active set" value={data.currentSetSize.toString()} color="var(--gold)" />
        <Tile label="Projected next set" value={data.projectedSetSize.toString()} color="var(--gold)" />
        <Tile label="Joining" value={data.joining.length.toString()} color="#4CAF6E" />
        <Tile label="Leaving" value={data.leaving.length.toString()} color="#E05252" />
        <Tile label="Stake movers" value={data.movers.length.toString()} color="#C9A84C" />
      </div>

      {/* Joining / Leaving side-by-side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16, marginBottom: 16 }}>
        <ValidatorList
          title="JOINING NEXT ROTATION"
          color="#4CAF6E"
          empty="No validators projected to join."
          rows={data.joining}
        />
        <ValidatorList
          title="LEAVING NEXT ROTATION"
          color="#E05252"
          empty="No validators projected to drop out."
          rows={data.leaving}
        />
      </div>

      {/* Stake movers */}
      {data.movers.length > 0 && (
        <div>
          <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, color: 'var(--gold)', letterSpacing: '0.08em', marginBottom: 4 }}>
            Stake Movers
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            Live stake (slot 2) diverged from snapshot stake (slot 8) by ≥{fmtStake(data.thresholds.moveMon)} MON or ≥{data.thresholds.movePct}%. These deltas will be absorbed into the next snapshot.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(201,168,76,0.06)' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Validator</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Snapshot</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Active</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Δ</th>
              </tr>
            </thead>
            <tbody>
              {data.movers.map(r => (
                <tr key={r.validatorId} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <Link href={`/validators/${r.authAddress}`} style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                      {r.moniker || shortAddr(r.authAddress)}
                    </Link>
                    <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 10, fontFamily: 'DM Mono, monospace' }}>#{r.validatorId}</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{fmtStake(r.snapshotStakeMon)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{fmtStake(r.activeStakeMon)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: r.deltaMon >= 0 ? '#4CAF6E' : '#E05252' }}>
                    {r.deltaMon >= 0 ? '+' : ''}{fmtStake(r.deltaMon)} ({r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(1)}%)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'rgba(255,255,255,0.01)' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color }}>{value}</div>
    </div>
  );
}

function ValidatorList({ title, color, empty, rows }: { title: string; color: string; empty: string; rows: SetMember[] }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: `${color}10` }}>
        <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 12, letterSpacing: '0.1em', color }}>
          {title} ({rows.length})
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          {empty}
        </div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {rows.map(r => (
            <div key={r.validatorId} style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link href={`/validators/${r.authAddress}`} style={{ color: 'var(--gold)', textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                  {r.moniker || shortAddr(r.authAddress)}
                </Link>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                  #{r.validatorId}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                {fmtStake(r.snapshotStakeMon)} MON
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
