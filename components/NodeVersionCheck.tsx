'use client';
import { useEffect, useState } from 'react';

interface ClientVersionInfo {
  rpc: string | null;
  installed: string | null;
  latest: string | null;
  latestUrl: string | null;
  isUpToDate: boolean | null;
  rpcMatchesInstalled: boolean | null;
}

export default function NodeVersionCheck() {
  const [v, setV] = useState<ClientVersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/network-health', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json() as { clientVersion: ClientVersionInfo };
        if (!cancelled) setV(j.clientVersion);
      } catch { /* silent */ }
    };
    load();
    const t = setInterval(load, 5 * 60_000);  // version check every 5 min is plenty
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!v) return null;

  const statusColor = v.isUpToDate === true ? '#4CAF6E'
                    : v.isUpToDate === false ? '#E8A020'
                    : 'var(--text-muted)';
  const statusLabel = v.isUpToDate === true ? 'UP-TO-DATE'
                    : v.isUpToDate === false ? 'UPDATE AVAILABLE'
                    : 'UNKNOWN';
  const statusIcon  = v.isUpToDate === true ? '✓'
                    : v.isUpToDate === false ? '⚠' : '?';

  return (
    <div className="card" style={{
      padding: '14px 20px', marginBottom: 16,
      borderLeft: `3px solid ${statusColor}`,
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto auto auto auto auto 1fr',
        gap: 20, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2 }}>
            INSTALLED (BeeHive)
          </div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 16, color: 'var(--gold)' }}>
            {v.installed ? `v${v.installed}` : '—'}
          </div>
        </div>
        <div style={{ color: 'rgba(138,136,112,0.25)', fontSize: 12 }}>vs</div>
        <div>
          <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2 }}>
            RPC GATEWAY
          </div>
          <div style={{
            fontFamily: 'DM Mono, monospace', fontSize: 14,
            color: v.rpcMatchesInstalled === false ? '#E8A020' : 'var(--text-muted)',
          }}>
            {v.rpc ?? '—'}
            {v.rpcMatchesInstalled === false && <span style={{ marginLeft: 6, fontSize: 10 }}>≠</span>}
          </div>
        </div>
        <div style={{ color: 'rgba(138,136,112,0.25)', fontSize: 12 }}>→</div>
        <div>
          <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2 }}>
            LATEST RELEASE
          </div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 16, color: 'var(--gold)' }}>
            {v.latestUrl && v.latest ? (
              <a href={v.latestUrl} target="_blank" rel="noreferrer" style={{
                color: 'inherit', textDecoration: 'none',
                borderBottom: '1px dotted rgba(201,168,76,0.4)',
              }}>
                {v.latest}
              </a>
            ) : (v.latest ?? '—')}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 4,
            background: `${statusColor}15`,
            border: `1px solid ${statusColor}40`,
            fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.08em',
            color: statusColor,
          }}>
            <span>{statusIcon}</span>
            <span>{statusLabel}</span>
          </div>
          {v.isUpToDate === false && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              pull latest release & redeploy
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
