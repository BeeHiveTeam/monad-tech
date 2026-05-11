'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface ScriptEntry {
  name: string;
  path: string;
  purpose: string;
  description: string;
  highlights: string[];
  rawUrl: string;
  githubUrl: string;
  installCmd: string;
  lines: number | null;
  lastCommitSha: string | null;
  lastCommitDate: string | null;
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
  scripts: ScriptEntry[];
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

export default function ToolsScriptsPage() {
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/tools/scripts', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setData(d as Catalog); })
      .catch(e => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
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
            <span>OPERATOR SCRIPTS</span>
          </div>

          <div style={{ marginBottom: 24 }}>
            <h1 style={{
              fontFamily: 'Bebas Neue, sans-serif',
              fontSize: 32, letterSpacing: '0.06em',
              color: 'var(--gold)',
              margin: '6px 0',
            }}>
              OPERATOR SCRIPTS
            </h1>
            <div style={{
              fontSize: 13, color: 'var(--text-muted)',
              maxWidth: 760, lineHeight: 1.65,
            }}>
              Three single-file bash scripts for Monad node operators. Each cross-references
              {' '}<a href="https://docs.monad.xyz/node-ops" target="_blank" rel="noreferrer"
                 style={{ color: 'var(--gold-dim)' }}>docs.monad.xyz/node-ops</a>{' '}
              for every check, every default, every fix-it command. Production-tested on
              the BeeHive testnet validator.
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
                BeeHiveTeam/monad-tools ↗
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

          {/* Script cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {(data?.scripts ?? []).map(s => (
              <div key={s.name} className="card" style={{ padding: '22px 24px' }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  flexWrap: 'wrap', alignItems: 'baseline', gap: 12,
                  marginBottom: 8,
                }}>
                  <div>
                    <h2 style={{
                      fontFamily: 'DM Mono, monospace',
                      fontSize: 20, fontWeight: 500,
                      color: 'var(--gold)',
                      margin: 0,
                    }}>
                      {s.name}
                    </h2>
                    <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 4 }}>
                      {s.purpose}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: 'DM Mono, monospace', fontSize: 10,
                    color: 'var(--text-muted)', letterSpacing: '0.05em',
                    textAlign: 'right',
                  }}>
                    {s.lines !== null && <div>{s.lines.toLocaleString()} lines</div>}
                    {s.lastCommitSha && (
                      <div>
                        <a href={`${data!.repo.url}/commit/${s.lastCommitSha}`}
                           target="_blank" rel="noreferrer"
                           style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
                          {s.lastCommitSha}
                        </a>
                        {' '}· {fmtDate(s.lastCommitDate)}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{
                  fontSize: 12, color: 'var(--text-muted)',
                  lineHeight: 1.65, marginBottom: 12,
                }}>
                  {s.description}
                </div>

                <ul style={{
                  margin: '0 0 14px 0', padding: '0 0 0 18px',
                  fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7,
                }}>
                  {s.highlights.map(h => <li key={h}>{h}</li>)}
                </ul>

                <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginTop: 6 }}>
                  QUICK START
                </div>
                <CopyBlock cmd={s.installCmd} />

                <div style={{ marginTop: 14, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
                  <a href={s.githubUrl} target="_blank" rel="noreferrer"
                     style={{ color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                    SOURCE ↗
                  </a>
                  <a href={s.rawUrl} target="_blank" rel="noreferrer"
                     style={{ color: 'var(--gold-dim)', letterSpacing: '0.06em' }}>
                    RAW SCRIPT ↗
                  </a>
                </div>
              </div>
            ))}
            {!data && !err && (
              <div className="card" style={{ padding: 18, fontSize: 12, color: 'var(--text-muted)' }}>
                Loading catalog from GitHub…
              </div>
            )}
          </div>

          {/* Coverage section */}
          <div className="card" style={{ padding: '22px 24px', marginTop: 22 }}>
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
                <a href="https://docs.monad.xyz/node-ops/hardware-requirements"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Hardware Requirements
                </a>{' '}
                — CPU 16 cores / 4.5 GHz+, RAM 32 GB+, NVMe 2 TB triedb + 500 GB OS,
                bare metal, SMT disabled, 300/100 Mbit/s
              </li>
              <li>
                <a href="https://docs.monad.xyz/node-ops/full-node-installation"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Full Node Installation
                </a>{' '}
                — Ubuntu 24.04+, kernel ≥6.8.0-60 (+ avoid 56–59), pkg.category.xyz apt repo,
                deb822 .sources format, /dev/triedb udev SYMLINK, iptables UDP DDoS filter
              </li>
              <li>
                <a href="https://docs.monad.xyz/node-ops/upgrade-instructions/auth-udp"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Authenticated UDP
                </a>{' '}
                — section-aware TOML key validation in [peer_discovery] and [network],
                two-tier version cutoff (0.12.6 capability / 0.14.0 operational)
              </li>
              <li>
                <a href="https://docs.monad.xyz/node-ops/validator-delegation-program"
                   target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
                  Validator Delegation Program
                </a>{' '}
                — flags publicly-exposed RPC ports (VDP forbids "external RPC servicing"),
                bare-metal verification, CVE-2026-31431 mitigation tracking
              </li>
            </ul>
          </div>

          {/* Why footer */}
          <div className="card" style={{
            padding: '18px 22px', marginTop: 16,
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
              Read the source before piping to bash. Each script is a single bash file —
              no minification, no included binaries. Issues and PRs welcome at{' '}
              <a href="https://github.com/BeeHiveTeam/monad-tools" target="_blank" rel="noreferrer"
                 style={{ color: 'var(--gold-dim)' }}>
                github.com/BeeHiveTeam/monad-tools
              </a>.
              Companion repo:{' '}
              <a href="/beehive" style={{ color: 'var(--gold-dim)' }}>
                BeeHive operator page
              </a>.
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
