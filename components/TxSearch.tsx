'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Accepts either a tx hash (0x + 64 hex) or a block number (pure digits).
// Tx → navigates to our /tx/[hash] which works for any historical tx
// (RPC eth_getTransactionByHash doesn't care about recency).
const HASH_RE  = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_RE = /^\d+$/;

export default function TxSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const s = q.trim();
    if (!s) { setErr('enter a tx hash'); return; }
    setErr(null);
    if (HASH_RE.test(s)) {
      setBusy(true);
      router.push(`/tx/${s.toLowerCase()}`);
      return;
    }
    if (BLOCK_RE.test(s)) {
      setErr('block search not wired yet — paste a transaction hash');
      return;
    }
    setErr('not a valid tx hash (expected 0x + 64 hex chars)');
  };

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '1 1 360px', minWidth: 0 }}
    >
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); if (err) setErr(null); }}
        placeholder="Search transaction by hash: 0x…"
        spellCheck={false}
        autoCorrect="off"
        style={{
          flex: 1, minWidth: 0,
          background: 'var(--surface2)',
          border: `1px solid ${err ? '#E0525280' : 'var(--border)'}`,
          borderRadius: 4, padding: '7px 10px',
          fontSize: 12, fontFamily: 'DM Mono, monospace',
          color: 'var(--text)', outline: 'none',
        }}
      />
      <button
        type="submit"
        disabled={busy}
        style={{
          padding: '7px 14px',
          background: 'transparent',
          border: '1px solid rgba(201,168,76,0.35)',
          borderRadius: 4,
          color: 'var(--gold)',
          fontFamily: 'Bebas Neue, sans-serif', fontSize: 13, letterSpacing: '0.08em',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? '…' : 'SEARCH'}
      </button>
      {err && (
        <span style={{
          position: 'absolute', marginTop: 36, marginLeft: 4,
          fontSize: 10, color: '#E05252',
        }}>
          {err}
        </span>
      )}
    </form>
  );
}
