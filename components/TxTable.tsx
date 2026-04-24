'use client';
import Link from 'next/link';
import { NetworkId } from '@/lib/networks';

interface Tx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  gasPrice: string;
}

interface Props {
  transactions: Tx[];
  network: NetworkId;
}

function short(addr: string | null, len = 8) {
  if (!addr) return 'Contract Create';
  return `${addr.slice(0, len)}…${addr.slice(-4)}`;
}

const nowrap: React.CSSProperties = { whiteSpace: 'nowrap' };

function fmtNum(n: number) {
  return n.toLocaleString('en-US');
}

export default function TxTable({ transactions }: Props) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ minWidth: 820 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', ...nowrap }}>Hash</th>
            <th style={{ textAlign: 'left', ...nowrap }}>From</th>
            <th style={{ textAlign: 'left', ...nowrap }}>To</th>
            <th style={{ textAlign: 'right', ...nowrap }}>Value (MON)</th>
            <th style={{ textAlign: 'right', ...nowrap }}>Gas (Gwei)</th>
            <th style={{ textAlign: 'right', ...nowrap }}>Block</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.hash}>
              <td style={nowrap}>
                <Link
                  href={`/tx/${tx.hash}`}
                  style={{ color: 'var(--gold)', fontFamily: 'DM Mono, monospace', fontSize: 12, textDecoration: 'none' }}
                >
                  {short(tx.hash, 10)}
                </Link>
              </td>
              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', ...nowrap }}>
                {short(tx.from)}
              </td>
              <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', ...nowrap }}>
                {short(tx.to)}
              </td>
              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 13, ...nowrap }}>
                {tx.value}
              </td>
              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', ...nowrap }}>
                {tx.gasPrice}
              </td>
              <td style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', ...nowrap }}>
                #{fmtNum(tx.blockNumber)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
