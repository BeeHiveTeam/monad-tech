import type { Metadata } from 'next';

export const metadata: Metadata = {
  // Root layout's title.template adds "· Monad Tech" — don't add it here too
  // (bug fixed 2026-05-21 audit B1).
  title: 'My delegations — portfolio view for Monad delegators',
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
