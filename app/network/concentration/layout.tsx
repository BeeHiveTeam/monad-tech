import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Stake Concentration Deep-Dive — Nakamoto, Gini, Lorenz',
  description:
    'Monad stake concentration deep-dive: Nakamoto coefficient at 33/50/66% thresholds, ' +
    'Gini coefficient, Lorenz curve, multi-ID operator clustering, top-20 stake table.',
  keywords: [
    'Monad decentralization', 'Nakamoto coefficient', 'Gini coefficient',
    'Lorenz curve', 'stake concentration', 'multi-ID operators',
  ],
  alternates: {
    canonical: 'https://monad-tech.com/network/concentration',
  },
  openGraph: {
    title: 'Monad Stake Concentration — Nakamoto, Gini, Lorenz',
    description: 'Per-operator stake-share, Nakamoto coefficient, Gini, Lorenz curve.',
    url: 'https://monad-tech.com/network/concentration',
    type: 'website',
  },
};

export default function ConcentrationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
