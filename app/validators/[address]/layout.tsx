import type { Metadata } from 'next';

// Per-validator metadata so the 200+ detail pages don't share /validators's
// canonical (audit-pass C6 — fixes duplicate-content SEO). We don't fetch the
// moniker server-side (would require an RPC round-trip on every Googlebot hit);
// the title shows the shortened address, which Google still indexes uniquely.
export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
  const { address } = await params;
  const safeAddr = /^0x[a-f0-9]{40}$/i.test(address) ? address.toLowerCase() : '0x';
  const short = `${safeAddr.slice(0, 10)}…${safeAddr.slice(-4)}`;
  return {
    title: `Validator ${short} — Monad Tech`,
    description: `Stake, commission, uptime, block production, on-chain delegators and composite 6-axis score for Monad validator ${short}. Live from the staking precompile.`,
    alternates: {
      canonical: `https://monad-tech.com/validators/${safeAddr}`,
    },
    openGraph: {
      title: `Monad Validator ${short}`,
      description: 'Live stake, commission, composite quality score, delegators, audit trail.',
      url: `https://monad-tech.com/validators/${safeAddr}`,
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: `Monad Validator ${short}`,
      description: 'Composite score, delegators, audit trail.',
    },
  };
}

export default function ValidatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
