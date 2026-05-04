/**
 * Site-wide footer rendered by RootLayout on every page. Surfaces operator
 * contacts (BeeHive website, Twitter, GitHub, Discord) so visitors landing
 * on any page — not just /beehive — can reach us. Discord handle copies to
 * clipboard on click since Discord usernames aren't directly linkable.
 */
'use client';

export default function Footer() {
  const copyDiscord = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText('mav3rick_iphone').catch(() => {});
    }
  };

  const linkStyle: React.CSSProperties = {
    color: 'var(--gold-dim)',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };
  const sep = (
    <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>·</span>
  );

  return (
    <footer
      style={{
        marginTop: 64,
        paddingTop: 24,
        paddingBottom: 32,
        paddingLeft: 16,
        paddingRight: 16,
        borderTop: '1px solid var(--border-dim, rgba(255,255,255,0.06))',
        color: 'var(--text-muted)',
        fontSize: 11,
        fontFamily: '"DM Mono", monospace',
        letterSpacing: '0.06em',
        textAlign: 'center',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ color: 'var(--gold-dim)' }}>🐝 BeeHive</span>
      {sep}
      <a href="https://bee-hive.work" style={linkStyle} target="_blank" rel="noreferrer">
        bee-hive.work
      </a>
      {sep}
      <a href="https://x.com/BeeHive_NT" style={linkStyle} target="_blank" rel="noreferrer">
        @BeeHive_NT
      </a>
      {sep}
      <a
        href="https://github.com/BeeHiveTeam/monad-tech"
        style={linkStyle}
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
      {sep}
      <button
        type="button"
        onClick={copyDiscord}
        title="Copy Discord username"
        style={{
          ...linkStyle,
          background: 'transparent',
          border: 'none',
          padding: 0,
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        Discord: mav3rick_iphone ⎘
      </button>
    </footer>
  );
}
