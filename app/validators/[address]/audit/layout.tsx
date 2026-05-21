import type { Metadata } from 'next';

// Audit-trail pages are operator tooling, not crawl-worthy. Distinct canonical
// from /validators (audit-pass C6) AND noindex to avoid filling Google's index
// with 200+ near-identical reward-log views.
export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
): Promise<Metadata> {
  const { address } = await params;
  const safeAddr = /^0x[a-f0-9]{40}$/i.test(address) ? address.toLowerCase() : '0x';
  const short = `${safeAddr.slice(0, 10)}…${safeAddr.slice(-4)}`;
  return {
    // Root layout's title.template adds "· Monad Tech" — keep clean (bug B1).
    title: `Audit Trail ${short}`,
    description: `On-chain ValidatorRewarded event receipts for ${short}. CSV-exportable reward ledger across all owned validator IDs.`,
    alternates: {
      canonical: `https://monad-tech.com/validators/${safeAddr}/audit`,
    },
    robots: { index: false, follow: true },
  };
}

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return children;
}
