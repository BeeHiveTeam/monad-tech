'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import Pagination from '@/components/Pagination';
import { useNetwork } from '@/lib/useNetwork';

interface BlockDetail {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  gasUtilPct: number;
  baseFeeGwei: string | null;
  size: number;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  extraData: string;
  txCount: number;
  transactions: Array<{
    hash: string;
    from: string;
    to: string | null;
    valueMon: string;
    gasPriceGwei: string;
  }>;
  error?: string;
}

function copyToClipboard(text: string) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '200px 1fr',
      gap: 16, padding: '10px 0',
      borderBottom: '1px solid rgba(201,168,76,0.06)',
      alignItems: 'start',
    }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase', paddingTop: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>
        {children}
      </div>
    </div>
  );
}

function Copyable({ value, href, short }: { value: string; href?: string; short?: boolean }) {
  const display = short && value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {href ? (
        <Link href={href} style={{ color: 'var(--gold)', textDecoration: 'none', borderBottom: '1px dotted rgba(201,168,76,0.4)' }}>
          {display}
        </Link>
      ) : <span>{display}</span>}
      <button
        onClick={() => copyToClipboard(value)}
        title="Copy"
        style={{
          background: 'transparent', border: '1px solid rgba(201,168,76,0.2)',
          color: 'var(--text-muted)', padding: '1px 6px', borderRadius: 3,
          fontSize: 9, cursor: 'pointer', fontFamily: 'DM Mono, monospace',
        }}
      >copy</button>
    </span>
  );
}

function fmtTime(ts: number) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const ago = Math.floor((Date.now() - ts * 1000) / 1000);
  const rel = ago < 60 ? `${ago}s ago`
            : ago < 3600 ? `${Math.floor(ago/60)}m ago`
            : ago < 86400 ? `${Math.floor(ago/3600)}h ago`
            : `${Math.floor(ago/86400)}d ago`;
  return `${d.toLocaleString('ru-RU', { hour12: false })} (${rel})`;
}

function shortAddr(a: string | null, len = 10) {
  if (!a) return '—';
  return `${a.slice(0, len)}…${a.slice(-6)}`;
}

const TX_PAGE_SIZE = 15;

export default function BlockPage() {
  const [network, setNetwork] = useNetwork();
  const params = useParams();
  const numberParam = (params?.number as string) ?? '';

  const [b, setB]     = useState<BlockDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [txPage, setTxPage] = useState(1);

  useEffect(() => {
    if (!numberParam) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/block/${numberParam}?network=${network}`, { cache: 'no-store' });
        const j = await r.json() as BlockDetail;
        if (!cancelled) {
          if (!r.ok || j.error) setErr(j.error ?? `HTTP ${r.status}`);
          else { setB(j); setErr(null); }
        }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [numberParam, network]);

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} />
        <main className="site-main">
          <TabNav />

          <div style={{ marginBottom: 20 }}>
            <h1 style={{
              fontFamily: 'Bebas Neue, sans-serif', fontSize: 36, letterSpacing: '0.04em',
              color: 'var(--gold)', marginBottom: 4,
            }}>
              Block {b ? `#${b.number.toLocaleString('en-US')}` : numberParam}
            </h1>
            {b && (
              <div style={{
                display: 'flex', gap: 16, marginTop: 8,
                fontSize: 11, fontFamily: 'DM Mono, monospace',
              }}>
                <Link
                  href={`/block/${b.number - 1}`}
                  style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
                >
                  ← #{(b.number - 1).toLocaleString('en-US')}
                </Link>
                <Link
                  href={`/block/${b.number + 1}`}
                  style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
                >
                  #{(b.number + 1).toLocaleString('en-US')} →
                </Link>
              </div>
            )}
          </div>

          {err && (
            <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
              Error: {err}
            </div>
          )}

          {!err && !b && (
            <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)' }}>
              Loading…
            </div>
          )}

          {b && (
            <>
              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                  OVERVIEW
                </div>
                <KV label="Block number">
                  <span style={{ color: 'var(--gold)', fontSize: 14 }}>#{b.number.toLocaleString('en-US')}</span>
                </KV>
                <KV label="Hash">
                  <Copyable value={b.hash} />
                </KV>
                <KV label="Parent hash">
                  <Copyable value={b.parentHash} href={`/block/${b.number - 1}`} />
                </KV>
                <KV label="Timestamp">
                  {fmtTime(b.timestamp)}
                </KV>
                <KV label="Miner / proposer">
                  <Copyable value={b.miner} />
                </KV>
                <KV label="Transactions">
                  <span style={{ color: 'var(--gold)' }}>{b.txCount}</span>
                </KV>
                <KV label="Size">
                  {b.size.toLocaleString('en-US')} bytes
                </KV>
              </div>

              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                  GAS
                </div>
                <KV label="Gas used">
                  {b.gasUsed.toLocaleString('en-US')}
                  <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
                    ({b.gasUtilPct.toFixed(2)}% of limit)
                  </span>
                </KV>
                <KV label="Gas limit">
                  {b.gasLimit.toLocaleString('en-US')}
                </KV>
                <KV label="Base fee">
                  {b.baseFeeGwei ? `${b.baseFeeGwei} Gwei` : '—'}
                </KV>
              </div>

              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                  MERKLE ROOTS
                </div>
                <KV label="State root">
                  <Copyable value={b.stateRoot} />
                </KV>
                <KV label="Transactions root">
                  <Copyable value={b.transactionsRoot} />
                </KV>
                <KV label="Receipts root">
                  <Copyable value={b.receiptsRoot} />
                </KV>
                {b.extraData && b.extraData !== '0x' && !/^0x0+$/.test(b.extraData) && (
                  <KV label="Extra data">
                    {b.extraData}
                  </KV>
                )}
              </div>

              {b.transactions.length > 0 && (
                <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                  <div style={{
                    fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)',
                    marginBottom: 12,
                  }}>
                    TRANSACTIONS ({b.transactions.length})
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ minWidth: 720, width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Hash</th>
                          <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>From</th>
                          <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>To</th>
                          <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>Value (MON)</th>
                          <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>Gas (Gwei)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.transactions
                          .slice((txPage - 1) * TX_PAGE_SIZE, txPage * TX_PAGE_SIZE)
                          .map(t => (
                          <tr key={t.hash}>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <Link
                                href={`/tx/${t.hash}`}
                                style={{
                                  color: 'var(--gold)', fontFamily: 'DM Mono, monospace',
                                  fontSize: 12, textDecoration: 'none',
                                }}
                              >
                                {shortAddr(t.hash, 10)}
                              </Link>
                            </td>
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {shortAddr(t.from)}
                            </td>
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {t.to ? shortAddr(t.to) : 'Contract Create'}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                              {t.valueMon}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {t.gasPriceGwei}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {b.transactions.length > TX_PAGE_SIZE && (
                    <Pagination
                      currentPage={txPage}
                      totalPages={Math.ceil(b.transactions.length / TX_PAGE_SIZE)}
                      onPageChange={setTxPage}
                    />
                  )}
                </div>
              )}

              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <Link href="/" style={{
                  color: 'var(--text-muted)', fontSize: 11,
                  letterSpacing: '0.08em', textDecoration: 'none',
                }}>
                  ← back to Network Status
                </Link>
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
