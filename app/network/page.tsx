'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import NextSetProjection from '@/components/NextSetProjection';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import Pagination from '@/components/Pagination';
import { useNetwork } from '@/lib/useNetwork';
import MainnetSoonCard from '@/components/MainnetSoonCard';

const REORGS_PAGE_SIZE = 10;

interface NakamotoEntry { n: number; cumPct: number }
interface TopValidator { address: string; moniker: string | null; stakeMon: number; sharePct: number }
interface NetworkHealth {
  fetchedAt: number;
  decentralization: {
    totalValidators: number;
    activeValidators: number;
    totalStakeMon: number;
    nakamoto: { threshold33: NakamotoEntry; threshold50: NakamotoEntry; threshold66: NakamotoEntry };
    top10SharePct: number;
    topValidators: TopValidator[];
  };
  clientVersion: {
    rpc: string | null;
    fetchedAt: number | null;
    latest: string | null;
    latestUrl: string | null;
    latestFetchedAt: number | null;
    isUpToDate: boolean | null;
    note: string;
  };
  reorgs: {
    recent: Array<{
      ts: number; blockNumber: number; oldHash: string; newHash: string; depth: number;
      newMiner?: string; newTxCount?: number; blockTs?: number; detectionLagSec?: number;
    }>;
    totalDetected: number;
    trackedBlocks: number;
    windowStart: number | null;
  };
  geo: {
    fetchedAt: number | null;
    totalPeers: number;
    byCountry: Array<{ country: string; countryCode: string; count: number }>;
    byAsn: Array<{ asn: string; org: string; count: number }>;
    sampleIps: number;
  };
  validatorSetChanges: {
    events: Array<{ ts: number; type: string; address: string; moniker?: string; oldStake?: number; newStake?: number; delta?: number }>;
    tracked: number;
    totalDetected?: number;
    totalIncludingRotation?: number;
    rotationFiltered?: number;
    historyWindowDays?: number;
  };
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', { hour12: false });
}

export default function NetworkPage() {
  const [network, setNetwork] = useNetwork();
  const [d, setD] = useState<NetworkHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reorgPage, setReorgPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/network-health', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as NetworkHealth;
        if (!cancelled) { setD(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (network === 'mainnet') {
    return (
      <>
        <HexBg />
        <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
          <SiteHeader network={network} onNetworkChange={setNetwork} />
          <main className="site-main">
            <TabNav />
            <MainnetSoonCard
              title="NETWORK HEALTH"
              description="Reorg detector, peer geo, validator-set churn, and decentralization metrics are computed from our own validator's Prometheus + journald via Loki. We'll bring this online for mainnet once we run a mainnet validator."
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
        <SiteHeader network={network} onNetworkChange={setNetwork} />
        <main className="site-main">
        <TabNav />

        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 42, letterSpacing: '0.04em', color: 'var(--gold)', marginBottom: 4 }}>
            Network Health
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Decentralization metrics, client version, reorgs and peer geography — not published by official tooling.
            Data is collected from our own node: validator registry, RPC, journald via Loki.
          </div>
        </div>


        {err && !d && (
          <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
            Error: {err}
          </div>
        )}
        {!d && !err && (
          <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)' }}>Loading…</div>
        )}

        {d && (
          <>
            {/* Epoch lifecycle + next-set projection */}
            <div style={{ marginBottom: 16 }}>
              <NextSetProjection network={network} />
            </div>

            {/* Decentralization / Nakamoto */}
            <Section
              title="DECENTRALIZATION · NAKAMOTO COEFFICIENT"
              subtitle="Minimum number of validators whose combined stake exceeds the threshold. BFT-safety requires >2/3, liveness-halt >1/3."
            >
              <div style={{ marginBottom: 14, fontSize: 11 }}>
                <Link
                  href="/network/concentration"
                  style={{
                    display: 'inline-block', padding: '4px 10px',
                    border: '1px solid var(--gold-dim)', borderRadius: 3,
                    color: 'var(--gold)', textDecoration: 'none',
                    background: 'rgba(201,168,76,0.08)', letterSpacing: '0.06em',
                  }}
                >
                  DEEP DIVE: Gini, Lorenz, multi-ID operators →
                </Link>
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 24, marginBottom: 20,
              }}>
                {[
                  { label: 'NAKAMOTO 33% (liveness)', entry: d.decentralization.nakamoto.threshold33, warn: d.decentralization.nakamoto.threshold33.n < 4 },
                  { label: 'NAKAMOTO 50%',            entry: d.decentralization.nakamoto.threshold50, warn: false },
                  { label: 'NAKAMOTO 66% (safety)',   entry: d.decentralization.nakamoto.threshold66, warn: d.decentralization.nakamoto.threshold66.n < 7 },
                ].map(x => (
                  <div key={x.label}>
                    <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
                      {x.label}
                    </div>
                    <div style={{
                      fontFamily: 'DM Mono, monospace', fontSize: 36,
                      color: x.warn ? '#E05252' : 'var(--gold)', fontWeight: 500,
                    }}>
                      {x.entry.n}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(138,136,112,0.7)' }}>
                      cumulative: {x.entry.cumPct.toFixed(2)}%
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Top operators by stake: <Link href="/network/concentration" style={{ color: 'var(--gold)' }}>see top-20 + Lorenz + Gini on the concentration deep-dive →</Link>
              </div>
            </Section>

            {/* Client version moved to Node Monitor — see TAB "Node Monitor" */}

            {/* Reorgs */}
            <Section
              title="REORGS"
              subtitle="Detected by comparing hashes at tip/tip-1/tip-2 every 4s. In-memory ring (since restart) merged with persisted history from InfluxDB (last 30 days)."
            >
              <div style={{ display: 'flex', gap: 32, marginBottom: 14, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>DETECTED</div>
                  <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 28, color: d.reorgs.totalDetected > 0 ? '#E05252' : 'var(--gold)' }}>
                    {d.reorgs.totalDetected}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>TRACKED BLOCKS</div>
                  <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 14, color: 'var(--text)' }}>{d.reorgs.trackedBlocks}</div>
                </div>
              </div>
              {d.reorgs.recent.length === 0 ? (
                <div style={{ padding: '10px', fontSize: 11, color: 'var(--text-muted)', border: '1px dashed rgba(201,168,76,0.1)', borderRadius: 4 }}>
                  No reorgs detected in this window — chain is stable.
                </div>
              ) : (() => {
                const totalReorgs = d.reorgs.recent.length;
                const totalPages = Math.max(1, Math.ceil(totalReorgs / REORGS_PAGE_SIZE));
                // Clamp page to valid range — list can shrink/grow between polls.
                const safePage = Math.min(Math.max(1, reorgPage), totalPages);
                const startIdx = (safePage - 1) * REORGS_PAGE_SIZE;
                const pageItems = d.reorgs.recent.slice(startIdx, startIdx + REORGS_PAGE_SIZE);
                return (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, fontFamily: 'DM Mono, monospace' }}>
                      Showing {startIdx + 1}–{startIdx + pageItems.length} of {totalReorgs}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {pageItems.map((r, i) => (
                        <div key={`${r.ts}-${r.blockNumber}-${i}`} style={{
                          padding: '8px 10px',
                          border: '1px solid rgba(201,168,76,0.06)',
                          borderLeft: '3px solid #E05252',
                          borderRadius: 4,
                          background: 'rgba(224,82,82,0.02)',
                          fontFamily: 'DM Mono, monospace', fontSize: 11,
                          lineHeight: 1.6,
                        }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
                            <span style={{ color: 'var(--text-muted)' }}>{fmtTime(r.ts)}</span>
                            <a
                              href={`/block/${r.blockNumber}`}
                              style={{ color: '#E05252', textDecoration: 'none', fontWeight: 500 }}
                            >
                              block {r.blockNumber.toLocaleString()}
                            </a>
                            <span style={{ color: 'var(--gold)' }}>depth {r.depth}</span>
                            {r.newTxCount !== undefined && (
                              <span style={{ color: 'var(--text-muted)' }}>{r.newTxCount} tx</span>
                            )}
                            {r.detectionLagSec !== undefined && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                detected +{r.detectionLagSec}s
                              </span>
                            )}
                          </div>
                          {r.newMiner && (
                            <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 10 }}>
                              replacement miner:{' '}
                              <a href={`/address/${r.newMiner}`} style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
                                {r.newMiner.slice(0, 14)}…{r.newMiner.slice(-6)}
                              </a>
                            </div>
                          )}
                          <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.oldHash.slice(0, 14)}… → {r.newHash.slice(0, 14)}…
                          </div>
                        </div>
                      ))}
                    </div>
                    <Pagination
                      currentPage={safePage}
                      totalPages={totalPages}
                      onPageChange={setReorgPage}
                    />
                  </>
                );
              })()}
            </Section>

            {/* Peer geo moved to /beehive — it reflects OUR validator's peer
                keepalive log, not the network's geographic distribution. */}

            {/* Validator set changes */}
            <Section
              title="VALIDATOR SET CHANGES"
              subtitle={d.validatorSetChanges.events.length === 0
                ? `Tracking ${d.validatorSetChanges.tracked} validators. No real undelegations observed in the last ${d.validatorSetChanges.historyWindowDays ?? 30} days.`
                : `${d.validatorSetChanges.events.length} of ${d.validatorSetChanges.totalDetected ?? d.validatorSetChanges.events.length} real stake changes shown — undelegations and additions only over last ${d.validatorSetChanges.historyWindowDays ?? 30} days.${
                    d.validatorSetChanges.rotationFiltered ? ` ${d.validatorSetChanges.rotationFiltered.toLocaleString()} epoch-rotation artifacts (Δ ≈ -11M MON when operators rotate out of the 200-slot active set, normal protocol behaviour) filtered out.` : ''
                  }`}
            >
              {d.validatorSetChanges.events.length === 0 ? (
                <div style={{ padding: '10px', fontSize: 11, color: 'var(--text-muted)', border: '1px dashed rgba(201,168,76,0.1)', borderRadius: 4 }}>
                  Monad testnet does not expose slashing events via RPC. Any future stake drop or removal will be surfaced here.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {d.validatorSetChanges.events.map((e, i) => (
                    <div key={i} className="row-valset">
                      <span className="col-time" style={{ color: 'var(--text-muted)' }}>{fmtTime(e.ts)}</span>
                      <span className="col-type" style={{
                        color: e.type === 'removed' ? '#E05252' : e.type === 'stake_decrease' ? '#E8A020' : 'var(--gold)',
                        textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em',
                      }}>
                        {e.type}
                      </span>
                      <span className="col-moniker" style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                        {e.moniker ? (
                          <a href={`/validators/${e.address}`}
                             style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {e.moniker}
                          </a>
                        ) : (
                          <a href={`/address/${e.address}`}
                             style={{ color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: 11, textDecoration: 'none' }}
                             title={e.address}>
                            {e.address.slice(0, 10) + '…' + e.address.slice(-4)}
                          </a>
                        )}
                      </span>
                      <span className="col-delta" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                        {e.delta !== undefined ? `Δ ${e.delta.toLocaleString()} MON` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
        </main>
      </div>
    </>
  );
}
