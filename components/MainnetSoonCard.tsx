'use client';

interface Props {
  /** Short label of the feature, e.g. "PARALLEL EXECUTION" */
  title: string;
  /** What this would show if available */
  description?: string;
}

/**
 * Placeholder card shown in place of testnet-only widgets when the user
 * is viewing the mainnet network. Most "testnet-only" widgets are sourced
 * from our own validator's Loki / Prometheus / WebSocket stack which we
 * only operate for testnet. We'll backfill these once we run a mainnet
 * validator of our own.
 */
export default function MainnetSoonCard({ title, description }: Props) {
  return (
    <div className="card" style={{
      padding: '24px',
      marginBottom: 16,
      background: 'linear-gradient(135deg, rgba(232,160,32,0.04) 0%, rgba(8,8,8,0.4) 100%)',
      border: '1px dashed rgba(232,160,32,0.25)',
      textAlign: 'center',
    }}>
      <div style={{
        fontFamily: 'Bebas Neue, sans-serif',
        letterSpacing: '0.08em', fontSize: 14,
        color: 'var(--gold)', marginBottom: 6,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 11, letterSpacing: '0.1em',
        color: '#E8A020', marginBottom: 8,
      }}>
        ⚠ MAINNET — COMING SOON
      </div>
      {description && (
        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          lineHeight: 1.5, maxWidth: 480, margin: '0 auto',
        }}>
          {description}
        </div>
      )}
    </div>
  );
}
