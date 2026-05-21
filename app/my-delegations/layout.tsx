import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'My delegations — portfolio view for Monad delegators · Monad Tech',
  description:
    'Paste your wallet address to see every Monad validator you have delegated to, ' +
    'with stake amount, commission, and contribution to total positions.',
  alternates: {
    canonical: 'https://monad-tech.com/my-delegations',
  },
  robots: { index: true, follow: true },
};

export default function MyDelegationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
