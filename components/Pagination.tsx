'use client';

interface Props {
  currentPage: number;   // 1-based
  totalPages: number;
  onPageChange: (page: number) => void;
}

// Pagination with sliding window: shows first, last, and up to 5 around current.
// Example for 20 pages at current=10: « 1 … 8 9 [10] 11 12 … 20 »
export default function Pagination({ currentPage, totalPages, onPageChange }: Props) {
  if (totalPages <= 1) return null;

  const pages: Array<number | '…'> = [];
  const push = (x: number | '…') => {
    if (x === '…' && pages[pages.length - 1] === '…') return;
    pages.push(x);
  };

  const w = 2;  // half-window around current
  const start = Math.max(2, currentPage - w);
  const end   = Math.min(totalPages - 1, currentPage + w);

  push(1);
  if (start > 2) push('…');
  for (let i = start; i <= end; i++) push(i);
  if (end < totalPages - 1) push('…');
  if (totalPages > 1) push(totalPages);

  const btn = (content: React.ReactNode, onClick: (() => void) | null, active = false): React.ReactNode => (
    <button
      onClick={onClick ?? undefined}
      disabled={!onClick}
      style={{
        minWidth: 30, height: 30, padding: '0 8px',
        background: active ? 'var(--gold)' : 'transparent',
        border: `1px solid ${active ? 'var(--gold)' : 'rgba(201,168,76,0.25)'}`,
        borderRadius: 4,
        color: active ? '#080808' : (onClick ? 'var(--text)' : 'rgba(138,136,112,0.35)'),
        fontFamily: 'DM Mono, monospace', fontSize: 12,
        cursor: onClick ? 'pointer' : 'not-allowed',
        transition: 'all 0.1s',
      }}
    >
      {content}
    </button>
  );

  return (
    <div style={{
      display: 'flex', gap: 4, alignItems: 'center',
      justifyContent: 'center', marginTop: 16, flexWrap: 'wrap',
    }}>
      {btn('«', currentPage > 1 ? () => onPageChange(1) : null)}
      {btn('‹', currentPage > 1 ? () => onPageChange(currentPage - 1) : null)}
      {pages.map((p, i) => p === '…'
        ? <span key={`e${i}`} style={{ color: 'var(--text-muted)', padding: '0 4px' }}>…</span>
        : <span key={p}>{btn(p, p !== currentPage ? () => onPageChange(p) : null, p === currentPage)}</span>
      )}
      {btn('›', currentPage < totalPages ? () => onPageChange(currentPage + 1) : null)}
      {btn('»', currentPage < totalPages ? () => onPageChange(totalPages) : null)}
    </div>
  );
}
