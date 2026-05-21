import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Delegate — pick a validator for Monad delegation · Monad Tech',
  description:
    'Find the best Monad validator for your delegation. Filters by net APR, commission, ' +
    'stake size, decentralization. Ranks validators with a delegator-facing composite ' +
    'score: realized APR × (1 − commission) × uptime × decentralization bonus.',
  keywords: [
    'Monad delegation', 'Monad validator picker', 'best Monad validator',
    'Monad APR', 'delegate MON',
  ],
  alternates: {
    canonical: 'https://monad-tech.com/delegate',
  },
  openGraph: {
    title: 'Delegate to a Monad validator — Monad Tech',
    description: 'Find the best validator for your delegation. Net APR, decentralization-weighted.',
    url: 'https://monad-tech.com/delegate',
    type: 'website',
  },
};

export default function DelegateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
