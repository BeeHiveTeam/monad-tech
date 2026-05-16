'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface StackComponent {
  name: string;
  port: string | null;
  image: string;
  purpose: string;
}
interface MonitoringStack {
  name: string;
  purpose: string;
  description: string;
  highlights: string[];
  components: StackComponent[];
  rawUrl: string;
  githubUrl: string;
  readmeUrl: string;
  installCmd: string;
  installCmdManual: string;
  upgradeCmd: string;
  uninstallCmd: string;
  healthcheckCmd: string;
  enableHostmetricsCmd: string;
}
interface RepoMeta {
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  lastCommitSha: string | null;
  lastCommitDate: string | null;
}
interface Catalog {
  repo: RepoMeta;
  stack: MonitoringStack;
  fetchedAt: number;
  cacheAgeSeconds: number;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60_000) return 'just now';
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  if (dt < 7 * 86_400_000) return `${Math.floor(dt / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString('ru-RU');
}

function CopyBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative', marginTop: 12 }}>
      <pre style={{
        margin: 0,
        padding: '12px 80px 12px 14px',
        background: 'rgba(0,0,0,0.4)',
        border: '1px solid rgba(201,168,76,0.15)',
        borderRadius: 4,
        fontFamily: 'DM Mono, monospace',
        fontSize: 11,
        color: 'var(--text)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        lineHeight: 1.6,
      }}>
        {cmd}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{
          position: 'absolute', top: 8, right: 8,
          padding: '4px 10px', fontSize: 10, fontFamily: 'DM Mono, monospace',
          letterSpacing: '0.06em',
          background: copied ? 'rgba(76,175,110,0.15)' : 'rgba(201,168,76,0.05)',
          color: copied ? '#4CAF6E' : 'var(--gold-dim)',
          border: `1px solid ${copied ? '#4CAF6E' : 'rgba(201,168,76,0.3)'}`,
          borderRadius: 4, cursor: 'pointer',
        }}
      >
        {copied ? '✓ COPIED' : 'COPY'}
      </button>
    </div>
  );
}

export default function ToolsMonitoringPage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetch('/api/tools/monitoring', { cache: 'no-store', signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { if (!cancelled) setData(d as Catalog); })
      .catch(e => { if (!cancelled && e.name !== 'AbortError') setErr(String(e)); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState="live" lastUpdate={null} />
        <main className="site-main">
          <TabNav />

          {/* Breadcrumb */}
          <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
            <a href="/tools" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>TOOLS</a>
            {' / '}
            <span>MONITORING STACK</span>
          </div>

          <div style={{ marginBottom: 24 }}>
            <h1 style={{
              fontFamily: 'Bebas Neue, sans-serif',
              fontSize: 32, letterSpacing: '0.06em',
              color: 'var(--gold)',
              margin: '6px 0',
            }}>
              MONITORING STACK
            </h1>
            <div style={{
              fontSize: 13, color: 'var(--text-muted)',
              maxWidth: 760, lineHeight: 1.65,
            }}>
              Self-hosted Grafana + Prometheus monitoring stack for any Monad node.
              Built on top of the{' '}
              <a href="https://docs.monad.xyz/node-ops/full-node-installation"
                 target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                bundled OpenTelemetry collector
              </a>{' '}— no extra agents on the host, just four Docker containers.
              Production-tested on the BeeHive testnet validator.
            </div>
          </div>

          {/* Repo header */}
          {data && (
            <div className="card" style={{
              padding: '14px 18px', marginBottom: 22,
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18,
              fontFamily: 'DM Mono, monospace', fontSize: 11,
              color: 'var(--text-muted)',
            }}>
              <a href={data.repo.url} target="_blank" rel="noreferrer"
                 style={{ color: 'var(--gold)', fontWeight: 500, textDecoration: 'none' }}>
                BeeHiveTeam/monad-grafana ↗
              </a>
              <span>⭐ {data.repo.stars}</span>
              <span>⑂ {data.repo.forks}</span>
              <span>last commit {data.repo.lastCommitSha ?? '—'}{' '}
                ({fmtDate(data.repo.lastCommitDate)})
              </span>
              <span style={{ marginLeft: 'auto', color: 'rgba(138,136,112,0.5)' }}>
                cache {data.cacheAgeSeconds}s
              </span>
            </div>
          )}

          {err && (
            <div className="card" style={{
              padding: 16, marginBottom: 18,
              background: 'rgba(224,82,82,0.05)',
              borderColor: 'rgba(224,82,82,0.3)',
              fontSize: 12, color: '#E05252',
            }}>
              Failed to load catalog: {err}
            </div>
          )}

          {/* Stack overview card */}
          {data && (
            <div className="card" style={{ padding: '22px 24px', marginBottom: 18 }}>
              <h2 style={{
                fontFamily: 'DM Mono, monospace',
                fontSize: 20, fontWeight: 500,
                color: 'var(--gold)',
                margin: 0,
              }}>
                {data.stack.name}
              </h2>
              <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 4, marginBottom: 12 }}>
                {data.stack.purpose}
              </div>
              <div style={{
                fontSize: 12, color: 'var(--text-muted)',
                lineHeight: 1.65, marginBottom: 14,
              }}>
                {data.stack.description}
              </div>

              <ul style={{
                margin: '0 0 18px 0', padding: '0 0 0 18px',
                fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7,
              }}>
                {data.stack.highlights.map(h => <li key={h}>{h}</li>)}
              </ul>

              <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginTop: 6 }}>
                QUICK START
              </div>
              <CopyBlock cmd={data.stack.installCmd} />

              <details style={{ marginTop: 12 }}>
                <summary style={{
                  cursor: 'pointer', fontSize: 11, letterSpacing: '0.06em',
                  color: 'var(--gold-dim)',
                }}>
                  MANUAL INSTALL (review the script first)
                </summary>
                <CopyBlock cmd={data.stack.installCmdManual} />
              </details>

              <div style={{ marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
                <a href={data.stack.githubUrl} target="_blank" rel="noreferrer"
                   style={{ color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                  SOURCE ↗
                </a>
                <a href={data.stack.rawUrl} target="_blank" rel="noreferrer"
                   style={{ color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                  RAW install.sh ↗
                </a>
                <a href={data.stack.readmeUrl} target="_blank" rel="noreferrer"
                   style={{ color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                  README ↗
                </a>
              </div>
            </div>
          )}

          {/* Components table */}
          {data && (
            <div className="card" style={{ padding: '22px 24px', marginBottom: 18 }}>
              <div style={{
                fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)',
                marginBottom: 12,
              }}>
                STACK COMPONENTS
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(201,168,76,0.15)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--gold-dim)', fontWeight: 500 }}>Service</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--gold-dim)', fontWeight: 500 }}>Port</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--gold-dim)', fontWeight: 500 }}>Image</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--gold-dim)', fontWeight: 500 }}>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stack.components.map(c => (
                    <tr key={c.name} style={{ borderBottom: '1px solid rgba(201,168,76,0.07)' }}>
                      <td style={{ padding: '10px', fontFamily: 'DM Mono, monospace', color: 'var(--text)' }}>{c.name}</td>
                      <td style={{ padding: '10px', fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>{c.port ?? '—'}</td>
                      <td style={{ padding: '10px', fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--text-muted)' }}>{c.image}</td>
                      <td style={{ padding: '10px', color: 'var(--text-muted)', lineHeight: 1.55 }}>{c.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Maintenance commands */}
          {data && (
            <div className="card" style={{ padding: '22px 24px', marginBottom: 18 }}>
              <div style={{
                fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)',
                marginBottom: 12,
              }}>
                MAINTENANCE
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>UPGRADE</div>
              <CopyBlock cmd={data.stack.upgradeCmd} />

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14 }}>
                ENABLE HOST METRICS (if Monad ships otelcol without hostmetrics receiver)
              </div>
              <CopyBlock cmd={data.stack.enableHostmetricsCmd} />

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14 }}>HEALTHCHECK</div>
              <CopyBlock cmd={data.stack.healthcheckCmd} />

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14 }}>UNINSTALL</div>
              <CopyBlock cmd={data.stack.uninstallCmd} />
            </div>
          )}

          {!data && !err && (
            <div className="card" style={{ padding: 18, fontSize: 12, color: 'var(--text-muted)' }}>
              Loading catalog from GitHub…
            </div>
          )}

          {/* Access guidance */}
          <div className="card" style={{ padding: '22px 24px', marginTop: 4, marginBottom: 16 }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)',
              marginBottom: 12,
            }}>
              ACCESSING THE DASHBOARD
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              Loopback-only by default (no public port exposure). Tunnel from your laptop:
            </div>
            <CopyBlock cmd={'ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 user@your.server\n# then open: http://localhost:3000'} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 12 }}>
              If you want Grafana reachable from outside the host (and you trust your auth setup),
              re-run the installer with{' '}
              <code style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--gold-dim)' }}>--public</code>.
              That binds Grafana on 0.0.0.0:3000 and opens UFW. Default admin password is generated
              and stored in <code style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: 'var(--gold-dim)' }}>/opt/monad-grafana/.env</code> mode 0600.
            </div>
          </div>

          {/* Coverage section */}
          <div className="card" style={{ padding: '22px 24px', marginBottom: 18 }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)',
              marginBottom: 12,
            }}>
              ALIGNMENT WITH OFFICIAL DOCS
            </div>
            <ul style={{
              margin: 0, padding: '0 0 0 18px',
              fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8,
            }}>
              <li>
                <a href="https://docs.monad.xyz/node-ops/full-node-installation"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Full Node Installation
                </a>{' '}— uses Monad&apos;s bundled otelcol on :8889, no extra collectors required
              </li>
              <li>
                <a href="https://docs.monad.xyz/node-ops/validator-delegation-program"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Validator Delegation Program
                </a>{' '}— stack stays loopback-only by default, no exposure of :8889/:8080/:8081
                that VDP forbids
              </li>
            </ul>
          </div>

          {/* Why footer */}
          <div className="card" style={{
            padding: '18px 22px',
            background: 'rgba(76,175,110,0.04)',
            borderColor: 'rgba(76,175,110,0.18)',
          }}>
            <div style={{
              fontSize: 11, letterSpacing: '0.12em', color: '#4CAF6E',
              marginBottom: 8,
            }}>
              OPEN SOURCE · MIT
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65 }}>
              Read the install script before piping to bash — single file, no minification.
              Issues and PRs welcome at{' '}
              <a href="https://github.com/BeeHiveTeam/monad-grafana" target="_blank" rel="noreferrer"
                 style={{ color: 'var(--gold-dim)' }}>
                github.com/BeeHiveTeam/monad-grafana
              </a>.
              Companion tools:{' '}
              <a href="/tools/scripts" style={{ color: 'var(--gold-dim)' }}>
                operator scripts
              </a>.
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
