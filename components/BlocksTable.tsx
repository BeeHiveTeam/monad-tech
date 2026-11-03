'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NetworkId } from '@/lib/networks';

interface Block {
  number: number;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  miner: string;
  hash: string;
}

interface Props {
  blocks: Block[];
  network: NetworkId;
}

function short(addr: string, len = 8) {
  return addr ? `${addr.slice(0, len)}…${addr.slice(-4)}` : '—';
}

function fmtNum(n: number) {
  return n.toLocaleString('en-US');
}

function gasBar(used: number, limit: number) {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
      <div style={{ width: 70, height: 4, background: 'rgba(201,168,76,0.1)', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gold)', borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>{pct}%</span>
    </div>
  );
}

const nowrap: React.CSSProperties = { whiteSpace: 'nowrap' };

export default function BlocksTable({ blocks }: Props) {
  const [nowSec, setNowSec] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, []);
  return (
    <div className="block-table-scroll" tabIndex={0} role="region" aria-label="Recent blocks; scroll horizontally for all columns" style={{ overflowX: 'auto' }}>
      <table style={{ minWidth: 720 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', ...nowrap, width: '18%' }}>Block</th>
            <th style={{ textAlign: 'left', ...nowrap, width: '20%' }}>Age</th>
            <th style={{ textAlign: 'right', ...nowrap, width: '10%' }}>Txns</th>
            <th style={{ textAlign: 'left', ...nowrap, width: '22%' }}>Gas Used</th>
            <th style={{ textAlign: 'left', ...nowrap, width: '30%' }}>Validator</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.number}>
              <td style={nowrap}>
                <Link
                  href={`/block/${b.number}`}
                  style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 13, textDecoration: 'none' }}
                >
                  #{fmtNum(b.number)}
                </Link>
              </td>
              <td style={{ color: 'var(--text-muted)', fontSize: 12, ...nowrap }}>
                <time dateTime={new Date(b.timestamp * 1000).toISOString()} title={new Date(b.timestamp * 1000).toLocaleString()}>
                  {nowSec == null ? '—' : `${Math.max(0, nowSec - b.timestamp)}s ago`}
                </time>
              </td>
              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 13, ...nowrap }}>
                {b.txCount}
              </td>
              <td style={nowrap}>{gasBar(b.gasUsed, b.gasLimit)}</td>
              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, ...nowrap }}>
                <Link
                  href={`/validators/${b.miner}`}
                  style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}
                  title={b.miner}
                >
                  {short(b.miner)}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
