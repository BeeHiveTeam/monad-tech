'use client';
import { useEffect, useState } from 'react';
import HexBg from '@/components/HexBg';
import SiteHeader from '@/components/SiteHeader';
import TabNav from '@/components/TabNav';
import { useNetwork } from '@/lib/useNetwork';

interface NetworkInfo {
  chainId: number;
  chainIdHex: string;
  name: string;
  currency: { name: string; symbol: string; decimals: number };
  explorers?: { name: string; url: string }[];
  faucets?: { name: string; url: string }[];
}
interface RpcEntry {
  network: string;
  provider: string;
  http: string;
  ws: string | null;
  notes: string;
}
interface RpcStatus {
  http: string;
  status: 'online' | 'offline' | 'unknown';
  latencyMs: number | null;
  medianLatencyMs: number | null;
  tipBlock: number | null;
  lastError: string | null;
  lastCheckedAt: number;
  history: number[];
}
interface ApiResp {
  catalog: {
    networks: Record<string, NetworkInfo>;
    rpcs: RpcEntry[];
  };
  status: RpcStatus[];
  lastFullScanAt: number;
  scanCount: number;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        padding: '3px 8px', fontSize: 10, fontFamily: 'DM Mono, monospace',
        background: copied ? 'rgba(76,175,110,0.2)' : 'transparent',
        color: copied ? '#4CAF6E' : 'var(--text-muted)',
        border: `1px solid ${copied ? '#4CAF6E' : 'var(--border)'}`,
        borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {copied ? '✓ COPIED' : 'COPY'}
    </button>
  );
}

function AddToMetaMaskButton({ network }: { network: NetworkInfo }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const onClick = async () => {
    interface EthProvider {
      request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
    }
    const eth = (window as unknown as { ethereum?: EthProvider }).ethereum;
    if (!eth) { alert('MetaMask (or compatible wallet) not detected.'); return; }
    setBusy(true);
    try {
      // Pick an RPC from the catalog for this network
      const params = [{
        chainId: network.chainIdHex,
        chainName: network.name,
        nativeCurrency: network.currency,
        rpcUrls: ['https://rpc.monad.xyz'],
        blockExplorerUrls: network.explorers?.map(e => e.url) ?? [],
      }];
      // For testnet override the rpc fallback
      if (network.chainId === 10143) params[0].rpcUrls = ['https://testnet-rpc.monad.xyz'];
      await eth.request({ method: 'wallet_addEthereumChain', params });
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };
  return (
    <button onClick={onClick} disabled={busy}
      style={{
        padding: '6px 14px', fontSize: 11, letterSpacing: '0.05em',
        fontFamily: 'DM Mono, monospace',
        background: done ? '#4CAF6E' : 'var(--gold)',
        color: '#000', border: 'none', borderRadius: 4,
        cursor: busy ? 'wait' : 'pointer',
      }}>
      {busy ? '…' : done ? '✓ ADDED' : '+ ADD TO METAMASK'}
    </button>
  );
}

function latencyColor(ms: number | null): string {
  if (ms === null) return 'var(--text-muted)';
  if (ms < 200)  return '#4CAF6E';
  if (ms < 500)  return '#C9A84C';
  if (ms < 1500) return '#E8A020';
  return '#E05252';
}

export default function ToolsRpcsPage() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [network, setNetwork] = useNetwork();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/tools/rpcs', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as ApiResp;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const statusByHttp = new Map((data?.status ?? []).map(s => [s.http, s]));
  const networks = data?.catalog.networks ?? {};

  return (
    <>
      <HexBg />
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh' }}>
        <SiteHeader network={network} onNetworkChange={setNetwork} liveState="live" lastUpdate={null} />
        <main className="site-main">
          <TabNav />

      <div className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
        <h1 style={{
          fontFamily: 'Bebas Neue, sans-serif', fontSize: 24, letterSpacing: '0.08em',
          color: 'var(--gold)', margin: 0, marginBottom: 6,
        }}>
          PUBLIC RPC ENDPOINTS
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Curated list of Monad RPCs that don&apos;t require API keys. Latency and tip-block
          are pinged once per minute from our dashboard server (Poland) — your geographic
          latency will differ. Sorted by median latency. PRs welcome at
          {' '}<a href="https://github.com/BeeHiveTeam/monad-tech/blob/main/data/monad-rpcs.json" target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>
            data/monad-rpcs.json
          </a>.
        </div>
        {data && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, fontFamily: 'DM Mono, monospace' }}>
            last scan {new Date(data.lastFullScanAt).toLocaleTimeString()} · scan #{data.scanCount}
          </div>
        )}
      </div>

      {err && (
        <div className="card" style={{ padding: 20, color: '#E05252' }}>{err}</div>
      )}

      {Object.entries(networks)
        .filter(([key]) => key === network)
        .map(([key, net]) => {
        const rows = (data?.catalog.rpcs ?? []).filter(r => r.network === key);
        const enriched = rows.map(r => ({ rpc: r, st: statusByHttp.get(r.http) ?? null }))
          .sort((a, b) => {
            // online first, then by median latency asc
            const aOn = a.st?.status === 'online' ? 0 : 1;
            const bOn = b.st?.status === 'online' ? 0 : 1;
            if (aOn !== bOn) return aOn - bOn;
            const aL = a.st?.medianLatencyMs ?? Infinity;
            const bL = b.st?.medianLatencyMs ?? Infinity;
            return aL - bL;
          });

        return (
          <div key={key} className="card" style={{ padding: '20px 24px', marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: 12, marginBottom: 14,
            }}>
              <div>
                <h2 style={{
                  fontFamily: 'Bebas Neue, sans-serif', fontSize: 20, letterSpacing: '0.08em',
                  color: 'var(--gold)', margin: 0,
                }}>{net.name}</h2>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', marginTop: 4 }}>
                  chainId <strong style={{ color: 'var(--text)' }}>{net.chainId}</strong> ({net.chainIdHex})
                  {' · '}
                  symbol <strong style={{ color: 'var(--text)' }}>{net.currency.symbol}</strong>
                  {' · '}{rows.length} public RPCs
                </div>
              </div>
              <AddToMetaMaskButton network={net} />
            </div>

            {/* RPC table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={th}>STATUS</th>
                    <th style={th}>PROVIDER</th>
                    <th style={th}>RPC URL</th>
                    <th style={{ ...th, textAlign: 'right' }}>LATENCY</th>
                    <th style={{ ...th, textAlign: 'right' }}>TIP BLOCK</th>
                    <th style={th}>WS</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map(({ rpc, st }) => {
                    const isOn = st?.status === 'online';
                    const ms = st?.medianLatencyMs ?? null;
                    return (
                      <tr key={rpc.http} style={{ borderBottom: '1px solid rgba(201,168,76,0.04)' }}>
                        <td style={td}>
                          <span style={{
                            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                            background: isOn ? '#4CAF6E' : (st ? '#E05252' : 'var(--text-muted)'),
                            marginRight: 6,
                          }} />
                          <span style={{
                            fontSize: 10, letterSpacing: '0.05em',
                            color: isOn ? '#4CAF6E' : (st ? '#E05252' : 'var(--text-muted)'),
                            fontFamily: 'DM Mono, monospace',
                          }}>
                            {st ? st.status.toUpperCase() : '...'}
                          </span>
                        </td>
                        <td style={td}>
                          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{rpc.provider}</span>
                          {rpc.notes && (
                            <div style={{ fontSize: 9, color: 'var(--text-muted)' }} title={rpc.notes}>
                              {rpc.notes.length > 30 ? rpc.notes.slice(0, 30) + '…' : rpc.notes}
                            </div>
                          )}
                        </td>
                        <td style={td}>
                          <code style={{
                            fontFamily: 'DM Mono, monospace', fontSize: 11,
                            color: 'var(--gold-dim)', wordBreak: 'break-all',
                          }}>
                            {rpc.http}
                          </code>
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: latencyColor(ms), fontFamily: 'DM Mono, monospace' }}>
                          {ms !== null ? `${ms}ms` : st?.lastError ? '—' : '...'}
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
                          {st?.tipBlock != null ? st.tipBlock.toLocaleString() : '—'}
                        </td>
                        <td style={{ ...td, fontSize: 10, color: rpc.ws ? '#4CAF6E' : 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
                          {rpc.ws ? '✓' : '—'}
                        </td>
                        <td style={td}>
                          <CopyButton text={rpc.http} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Explorers + faucets per network */}
            {(net.explorers || net.faucets) && (
              <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                {net.explorers && net.explorers.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ letterSpacing: '0.06em' }}>EXPLORERS:</span>{' '}
                    {net.explorers.map((e, i) => (
                      <span key={i}>
                        <a href={e.url} target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>{e.name}</a>
                        {i < net.explorers!.length - 1 && ' · '}
                      </span>
                    ))}
                  </div>
                )}
                {net.faucets && net.faucets.length > 0 && (
                  <div>
                    <span style={{ letterSpacing: '0.06em' }}>FAUCETS:</span>{' '}
                    {net.faucets.map((f, i) => (
                      <span key={i}>
                        <a href={f.url} target="_blank" rel="noreferrer" style={{ color: 'var(--gold-dim)' }}>{f.name}</a>
                        {i < net.faucets!.length - 1 && ' · '}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
        </main>
      </div>
    </>
  );
}

const th: React.CSSProperties = {
  fontSize: 10, fontWeight: 500, letterSpacing: '0.08em',
  color: 'var(--text-muted)', textTransform: 'uppercase',
  padding: '10px 10px', textAlign: 'left',
};
const td: React.CSSProperties = { fontSize: 12, padding: '10px 10px' };
