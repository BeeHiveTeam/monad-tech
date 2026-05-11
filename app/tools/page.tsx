'use client';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface ToolCard {
  emoji: string;
  title: string;
  blurb: string;
  details: string;
  href: string;
  external?: boolean;
  badge?: string;
}

const TOOLS: ToolCard[] = [
  {
    emoji: '🔧',
    title: 'Public RPC Catalog',
    blurb: 'Live latency board for 19 public Monad RPCs',
    details:
      "Pings 11 mainnet + 8 testnet endpoints every 60s, ranks by median latency, " +
      "exposes 'Add to MetaMask' per network. Foundation, Alchemy, Ankr, dRPC, " +
      "OnFinality, Tenderly, thirdweb, bloXroute, Tatum, MonadInfra, Natsai.",
    href: '/tools/rpcs',
  },
  {
    emoji: '🩺',
    title: 'Operator Scripts',
    blurb: 'Pre-flight check, host setup, Auth UDP verifier — all in bash',
    details:
      "Three single-file bash scripts that take a fresh Ubuntu 24.04 box to a fully-" +
      "configured Monad validator: monad-doctor (32+ readiness checks), " +
      "monad-validator-setup (14 idempotent install steps), monad-authudp-check " +
      "(0.14.3 enforcement compliance). Cross-referenced against docs.monad.xyz.",
    href: '/tools/scripts',
    badge: 'NEW',
  },
];

export default function ToolsHub() {
  const [network, setNetwork] = useNetwork();
  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState="live" lastUpdate={null} />
        <main className="site-main">
          <TabNav />

          <div style={{ marginBottom: 28 }}>
            <h1 style={{
              fontFamily: 'Bebas Neue, sans-serif',
              fontSize: 32, letterSpacing: '0.06em',
              color: 'var(--gold)',
              margin: '12px 0 6px',
            }}>
              TOOLS
            </h1>
            <div style={{
              fontSize: 13, color: 'var(--text-muted)',
              maxWidth: 720, lineHeight: 1.6,
            }}>
              Open-source operator tooling by BeeHive. Built for Monad node operators,
              cross-referenced against{' '}
              <a href="https://docs.monad.xyz/node-ops" target="_blank" rel="noreferrer"
                 style={{ color: 'var(--gold-dim)' }}>docs.monad.xyz/node-ops</a>{' '}
              for every check and config defaults aligned with the latest
              Foundation announcements.
            </div>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 16,
          }}>
            {TOOLS.map(t => (
              <a key={t.title} href={t.href}
                 target={t.external ? '_blank' : undefined}
                 rel={t.external ? 'noreferrer' : undefined}
                 className="card"
                 style={{
                   padding: '24px 22px',
                   textDecoration: 'none',
                   display: 'block',
                   transition: 'border-color 0.15s, transform 0.15s',
                 }}
                 onMouseEnter={e => {
                   (e.currentTarget as HTMLElement).style.borderColor = 'var(--gold)';
                   (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)';
                 }}
                 onMouseLeave={e => {
                   (e.currentTarget as HTMLElement).style.borderColor = '';
                   (e.currentTarget as HTMLElement).style.transform = '';
                 }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 28 }}>{t.emoji}</span>
                  <h2 style={{
                    fontFamily: 'Bebas Neue, sans-serif',
                    fontSize: 22, letterSpacing: '0.06em',
                    color: 'var(--gold)',
                    margin: 0,
                  }}>
                    {t.title}
                  </h2>
                  {t.badge && (
                    <span style={{
                      fontSize: 9, letterSpacing: '0.1em',
                      padding: '2px 7px', borderRadius: 4,
                      background: 'rgba(76,175,110,0.12)',
                      color: '#4CAF6E',
                      border: '1px solid rgba(76,175,110,0.3)',
                    }}>
                      {t.badge}
                    </span>
                  )}
                </div>
                <div style={{
                  fontSize: 13, color: 'var(--text)', marginBottom: 10, fontWeight: 500,
                }}>
                  {t.blurb}
                </div>
                <div style={{
                  fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55,
                }}>
                  {t.details}
                </div>
                <div style={{
                  marginTop: 14, fontSize: 11, letterSpacing: '0.06em',
                  color: 'var(--gold-dim)', fontFamily: 'DM Mono, monospace',
                }}>
                  {t.external ? 'OPEN ON GITHUB →' : 'OPEN →'}
                </div>
              </a>
            ))}
          </div>

          <div style={{
            marginTop: 36, padding: '20px 22px',
            background: 'rgba(201,168,76,0.04)',
            border: '1px solid rgba(201,168,76,0.12)',
            borderRadius: 6,
            fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--gold)', letterSpacing: '0.05em' }}>WHY WE PUBLISH THIS</strong>
            <br />
            We run Monad validator (testnet) and built these tools for ourselves first.
            They encode the lessons we learned the hard way: a kernel in the buggy
            6.8.0-{'{'}56..59{'}'} range causing client hangs, NVMe stuck on
            4096-byte LBA tanking triedb performance, vm.swappiness=60 inflating p99
            vote_delay metrics.
            Open-sourcing them is the cheapest way to help other operators avoid the
            same traps — and it lets the community audit our work.
          </div>
        </main>
      </div>
    </>
  );
}
