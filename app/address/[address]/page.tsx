'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';
import { formatDistanceToNow } from 'date-fns';

interface AddressData {
  address: string;
  network: string;
  balanceMon: number;
  isContract: boolean;
  codeSize: number;
  nonce: number;
  validator: {
    registered: boolean;
    moniker: string;
    validatorId: number | null;
    stakeMon: number | null;
    commissionPct: number | null;
    website: string | null;
    description: string | null;
    x: string | null;
  } | null;
  minedBlocks: { number: number; timestamp: number; txCount: number }[];
  recentTxs: {
    hash: string; blockNumber: number;
    from: string; to: string | null;
    valueMon: string; direction: 'in' | 'out' | 'self';
  }[];
  ringSize: number;
  fetchedAt: number;
  error?: string;
}

function shorten(addr: string | null): string {
  if (!addr) return '—';
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function fmtMon(n: number, decimals = 4): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M MON`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K MON`;
  return `${n.toFixed(decimals)} MON`;
}

function copy(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

export default function AddressPage() {
  const params = useParams();
  const address = ((params?.address as string) ?? '').toLowerCase();
  const [network, setNetwork] = useNetwork();
  const [data, setData] = useState<AddressData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    fetch(`/api/address/${address}?network=${network}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [address, network]);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState={loading ? 'loading' : 'live'} lastUpdate={null} />

        <main className="site-main">
          <TabNav />

          <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
            <Link href="/" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>← Home</Link>
          </div>

          {loading ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading address data…
            </div>
          ) : data?.error ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: '#E05252' }}>
              {data.error}
            </div>
          ) : data ? (
            <>
              {/* If the address is a known validator, route the user to the
                  richer /validators detail page. Show a banner instead of
                  duplicating the data here. */}
              {data.validator && (
                <div className="card" style={{ padding: '14px 18px', marginBottom: 14, borderColor: 'rgba(201,168,76,0.4)' }}>
                  <div style={{ fontSize: 11, color: 'var(--gold-dim)', letterSpacing: '0.08em', marginBottom: 4 }}>
                    REGISTERED VALIDATOR
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)', letterSpacing: '0.04em' }}>
                      {data.validator.moniker}
                      {data.validator.validatorId != null && (
                        <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-muted)' }}>
                          #{data.validator.validatorId}
                        </span>
                      )}
                    </div>
                    <Link
                      href={`/validators/${data.address}`}
                      style={{
                        padding: '6px 14px', borderRadius: 4,
                        border: '1px solid var(--gold)', color: 'var(--gold)',
                        fontFamily: 'DM Mono, monospace', fontSize: 11, letterSpacing: '0.06em',
                        textDecoration: 'none', background: 'rgba(201,168,76,0.12)',
                      }}
                    >
                      OPEN VALIDATOR PAGE →
                    </Link>
                  </div>
                </div>
              )}

              {/* Header card */}
              <div className="card" style={{ padding: 20, marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 6 }}>
                  {data.isContract ? 'CONTRACT ADDRESS' : 'EXTERNALLY-OWNED ACCOUNT'}
                </div>
                <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 14, color: 'var(--text)', wordBreak: 'break-all', marginBottom: 8 }}>
                  {data.address}
                </div>
                <button
                  onClick={() => copy(data.address)}
                  style={{
                    padding: '4px 10px', fontSize: 10,
                    background: 'transparent', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 4,
                    cursor: 'pointer', fontFamily: 'DM Mono, monospace', letterSpacing: '0.06em',
                  }}
                >COPY</button>
              </div>

              {/* Key stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>BALANCE</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)' }}>{fmtMon(data.balanceMon)}</div>
                </div>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>NONCE</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)' }}>{data.nonce.toLocaleString('en-US')}</div>
                </div>
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>TYPE</div>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 18, color: 'var(--gold)' }}>
                    {data.isContract ? 'Contract' : 'EOA'}
                  </div>
                  {data.isContract && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      bytecode {data.codeSize.toLocaleString('en-US')} bytes
                    </div>
                  )}
                </div>
                {data.validator && (
                  <div className="card" style={{ padding: '14px 18px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 4 }}>STAKE</div>
                    <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 22, color: 'var(--gold)' }}>
                      {data.validator.stakeMon != null ? fmtMon(data.validator.stakeMon, 1) : '—'}
                    </div>
                  </div>
                )}
              </div>

              {/* Mined blocks */}
              {data.minedBlocks.length > 0 && (
                <div className="card" style={{ padding: '20px 24px', marginBottom: 14 }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 12 }}>
                    MINED BLOCKS · {data.minedBlocks.length} <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>(in last {data.ringSize} blocks)</span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em', padding: '6px 0' }}>Block</th>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Txs</th>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.minedBlocks.map(b => (
                          <tr key={b.number}>
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, padding: '4px 0' }}>
                              <Link href={`/block/${b.number}`} style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
                                #{b.number.toLocaleString('en-US')}
                              </Link>
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                              {b.txCount}
                            </td>
                            <td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {formatDistanceToNow(new Date(b.timestamp * 1000), { addSuffix: true })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Recent transactions */}
              {data.recentTxs.length > 0 ? (
                <div className="card" style={{ padding: '20px 24px', marginBottom: 14 }}>
                  <div style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 14, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 12 }}>
                    RECENT TRANSACTIONS · {data.recentTxs.length} <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>(in last {data.ringSize} blocks)</span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em', padding: '6px 0' }}>Direction</th>
                          <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Hash</th>
                          <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Counterparty</th>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Value</th>
                          <th style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Block</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recentTxs.map(tx => {
                          const counterparty = tx.direction === 'out' ? tx.to : tx.from;
                          const dirColor =
                            tx.direction === 'out' ? '#E05252' :
                            tx.direction === 'in' ? '#4CAF6E' : 'var(--gold-dim)';
                          return (
                            <tr key={tx.hash}>
                              <td style={{ padding: '4px 0' }}>
                                <span style={{ fontSize: 10, color: dirColor, letterSpacing: '0.06em', fontFamily: 'DM Mono, monospace' }}>
                                  {tx.direction === 'out' ? '↗ OUT' : tx.direction === 'in' ? '↙ IN' : '⇄ SELF'}
                                </span>
                              </td>
                              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                                <Link href={`/tx/${tx.hash}`} style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
                                  {shorten(tx.hash)}
                                </Link>
                              </td>
                              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                                {counterparty ? (
                                  <Link href={`/address/${counterparty}`} style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
                                    {shorten(counterparty)}
                                  </Link>
                                ) : <span style={{ color: 'rgba(138,136,112,0.45)', fontStyle: 'italic' }}>—</span>}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text)' }}>
                                {parseFloat(tx.valueMon) > 0 ? `${parseFloat(tx.valueMon).toFixed(4)} MON` : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12 }}>
                                <Link href={`/block/${tx.blockNumber}`} style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>
                                  #{tx.blockNumber.toLocaleString('en-US')}
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="card" style={{ padding: '14px 18px', marginBottom: 14, color: 'var(--text-muted)', fontSize: 12 }}>
                  No transactions involving this address in the last {data.ringSize} blocks.
                  Older history is not available — Monad public RPC doesn&apos;t support address-indexed lookups.
                </div>
              )}

              <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(138,136,112,0.5)', lineHeight: 1.5 }}>
                Balance, code and nonce are read live from the Monad node. Mined blocks and recent
                transactions are scanned from the dashboard&apos;s in-memory ring buffer (last ~{data.ringSize}
                blocks). For deep historical lookups across the entire chain, use a full block explorer.
              </div>
            </>
          ) : null}

          <div style={{ textAlign: 'center', marginTop: 40, paddingBottom: 32, color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em' }}>
            <Link href="/" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>BeeHive</Link>
            {' '}·{' '}Monad Network Monitor
          </div>
        </main>
      </div>
    </>
  );
}
