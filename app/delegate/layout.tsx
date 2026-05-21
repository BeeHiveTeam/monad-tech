import type { Metadata } from 'next';

// Kept after the page became a redirect to /validators?view=delegator (audit
// 2026-05-21) so external "monad-tech.com/delegate" links still surface
// reasonable SEO metadata in unfurls before the redirect fires.
export const metadata: Metadata = {
  title: 'Delegate — pick a validator for Monad delegation · Monad Tech',
  description:
    'Find the best Monad validator for your delegation. Net APR, decentralization-weighted picker. ' +
    'Now part of /validators as the Delegator view mode.',
  alternates: {
    canonical: 'https://monad-tech.com/validators?view=delegator',
  },
};

export default function DelegateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
