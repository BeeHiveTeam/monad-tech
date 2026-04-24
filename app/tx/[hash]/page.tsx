'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface TxDetail {
  hash: string;
  status: 'success' | 'failed' | 'pending';
  blockNumber: number | null;
  blockHash: string | null;
  blockTimestamp: number | null;
  transactionIndex: number | null;
  from: string;
  to: string | null;
  contractAddress: string | null;
  value: { wei: string; mon: string };
  nonce: number | null;
  gas: {
    limit: number | null;
    used: number | null;
    price_gwei: string;
    effective_price_gwei: string;
    max_fee_gwei: string | null;
    max_priority_gwei: string | null;
    fee_mon: string;
    cumulative_used: number | null;
  };
  input: string;
  inputMethodId: string | null;
  type?: string;
  chainId: number | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    logIndex: number | null;
  }>;
  error?: string;
}

function copyToClipboard(text: string) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '200px 1fr',
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

function Copyable({ value, href }: { value: string; href?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {href ? (
        <Link href={href} style={{ color: 'var(--gold)', textDecoration: 'none', borderBottom: '1px dotted rgba(201,168,76,0.4)' }}>
          {value}
        </Link>
      ) : (
        <span>{value}</span>
      )}
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

function fmtTime(ts: number | null) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const ago = Math.floor((Date.now() - ts * 1000) / 1000);
  const rel = ago < 60 ? `${ago}s ago`
            : ago < 3600 ? `${Math.floor(ago/60)}m ago`
            : ago < 86400 ? `${Math.floor(ago/3600)}h ago`
            : `${Math.floor(ago/86400)}d ago`;
  return `${d.toLocaleString('ru-RU', { hour12: false })} (${rel})`;
}

export default function TxPage() {
  const [network, setNetwork] = useNetwork();
  const params = useParams();
  const hash = (params?.hash as string) ?? '';

  const [tx, setTx]   = useState<TxDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/tx/${hash}?network=${network}`, { cache: 'no-store' });
        const j = await r.json() as TxDetail;
        if (!cancelled) {
          if (!r.ok || j.error) setErr(j.error ?? `HTTP ${r.status}`);
          else setTx(j);
        }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [hash, network]);

  const status = tx?.status;
  const statusColor = status === 'success' ? '#4CAF6E'
                    : status === 'failed'  ? '#E05252'
                    : 'var(--gold)';
  const statusLabel = status === 'success' ? '✓ SUCCESS'
                    : status === 'failed'  ? '✕ FAILED'
                    : '· PENDING';

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
            Transaction Details
          </h1>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>
            {hash}
          </div>
        </div>

        {err && (
          <div className="card" style={{ padding: '20px 24px', color: '#E05252', fontSize: 13 }}>
            Error: {err}
          </div>
        )}

        {!err && !tx && (
          <div className="card" style={{ padding: '20px 24px', color: 'var(--text-muted)' }}>
            Loading…
          </div>
        )}

        {tx && (
          <>
            <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                gap: 16, marginBottom: 18, flexWrap: 'wrap',
              }}>
                <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)' }}>
                  OVERVIEW
                </div>
                <div style={{
                  fontFamily: 'DM Mono, monospace', fontSize: 14, letterSpacing: '0.08em',
                  color: statusColor, padding: '4px 10px', borderRadius: 4,
                  background: `${statusColor}15`, border: `1px solid ${statusColor}40`,
                }}>
                  {statusLabel}
                </div>
              </div>

              <KV label="Hash">
                <Copyable value={tx.hash} />
              </KV>
              <KV label="Block">
                {tx.blockNumber !== null ? (
                  <span>
                    <span style={{ color: 'var(--gold)' }}>#{tx.blockNumber.toLocaleString('en-US')}</span>
                    {tx.transactionIndex !== null && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
                        (index {tx.transactionIndex})
                      </span>
                    )}
                  </span>
                ) : '—'}
              </KV>
              <KV label="Timestamp">
                {fmtTime(tx.blockTimestamp)}
              </KV>
              <KV label="From">
                <Copyable value={tx.from} />
              </KV>
              <KV label="To">
                {tx.to ? (
                  <Copyable value={tx.to} />
                ) : tx.contractAddress ? (
                  <span>
                    Contract Creation: <Copyable value={tx.contractAddress} />
                  </span>
                ) : '—'}
              </KV>
              <KV label="Value">
                <span style={{ color: 'var(--gold)', fontSize: 14 }}>
                  {tx.value.mon} MON
                </span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 12, fontSize: 11 }}>
                  ({tx.value.wei} wei)
                </span>
              </KV>
              <KV label="Transaction fee">
                <span style={{ color: 'var(--gold)' }}>{tx.gas.fee_mon} MON</span>
              </KV>
              <KV label="Gas price">
                {tx.gas.effective_price_gwei} Gwei
                {tx.gas.price_gwei !== tx.gas.effective_price_gwei && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
                    (submitted {tx.gas.price_gwei})
                  </span>
                )}
              </KV>
            </div>

            <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                GAS & FEES
              </div>
              <KV label="Gas limit">{tx.gas.limit?.toLocaleString('en-US') ?? '—'}</KV>
              <KV label="Gas used">
                {tx.gas.used?.toLocaleString('en-US') ?? '—'}
                {tx.gas.limit && tx.gas.used && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
                    ({((tx.gas.used / tx.gas.limit) * 100).toFixed(2)}%)
                  </span>
                )}
              </KV>
              {tx.gas.max_fee_gwei && (
                <KV label="Max fee per gas">{tx.gas.max_fee_gwei} Gwei</KV>
              )}
              {tx.gas.max_priority_gwei && (
                <KV label="Max priority fee">{tx.gas.max_priority_gwei} Gwei</KV>
              )}
              <KV label="Cumulative gas used">{tx.gas.cumulative_used?.toLocaleString('en-US') ?? '—'}</KV>
            </div>

            <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                TECHNICAL
              </div>
              <KV label="Nonce">{tx.nonce ?? '—'}</KV>
              <KV label="Type">{tx.type ?? '—'}</KV>
              <KV label="Chain ID">{tx.chainId ?? '—'}</KV>
              <KV label="Method ID">{tx.inputMethodId ?? '(none)'}</KV>
              <KV label="Input data">
                {tx.input && tx.input !== '0x' ? (
                  <details>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                      {tx.input.length > 40 ? `${tx.input.slice(0, 40)}… (${tx.input.length} chars, click to expand)` : tx.input}
                    </summary>
                    <pre style={{
                      marginTop: 8, padding: '10px', borderRadius: 4,
                      background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(201,168,76,0.08)',
                      fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      color: 'rgba(200,200,180,0.75)',
                    }}>
                      {tx.input}
                    </pre>
                  </details>
                ) : '(empty)'}
              </KV>
            </div>

            {tx.logs.length > 0 && (
              <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--gold)', marginBottom: 10 }}>
                  EVENT LOGS ({tx.logs.length})
                </div>
                {tx.logs.map((log, i) => (
                  <div key={i} style={{
                    padding: '12px', marginBottom: 8,
                    border: '1px solid rgba(201,168,76,0.08)', borderRadius: 4,
                    background: 'rgba(0,0,0,0.3)',
                  }}>
                    <div style={{
                      fontSize: 10, letterSpacing: '0.08em', color: 'var(--gold)',
                      marginBottom: 6, fontFamily: 'DM Mono, monospace',
                    }}>
                      LOG #{log.logIndex}
                    </div>
                    <div style={{ fontSize: 11, fontFamily: 'DM Mono, monospace', marginBottom: 6 }}>
                      <span style={{ color: 'var(--text-muted)' }}>address: </span>
                      <span style={{ color: 'var(--text)' }}>{log.address}</span>
                    </div>
                    <div style={{ fontSize: 11, fontFamily: 'DM Mono, monospace', marginBottom: 6 }}>
                      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>topics:</div>
                      {log.topics.map((t, j) => (
                        <div key={j} style={{ color: 'var(--text)', marginLeft: 12, wordBreak: 'break-all' }}>
                          [{j}] {t}
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }}>
                      <span style={{ color: 'var(--text-muted)' }}>data: </span>
                      <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{log.data}</span>
                    </div>
                  </div>
                ))}
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
