'use client';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
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
  return (
    <div style={{ overflowX: 'auto' }}>
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
                {formatDistanceToNow(new Date(b.timestamp * 1000), { addSuffix: true })}
              </td>
              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 13, ...nowrap }}>
                {b.txCount}
              </td>
              <td style={nowrap}>{gasBar(b.gasUsed, b.gasLimit)}</td>
              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', ...nowrap }}>
                {short(b.miner)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
