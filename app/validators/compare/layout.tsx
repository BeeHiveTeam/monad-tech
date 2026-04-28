import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Validator Comparison — Side-by-side Stake, Health, Participation",
  description:
    "Compare 2-5 Monad validators side-by-side: stake, commission, health score, " +
    "uptime, short-window participation, long-window participation, cumulative blocks. " +
    "Built for delegators choosing where to stake.",
  keywords: [
    "Monad validator compare", "validator comparison", "validator metrics",
    "delegation choice", "stake comparison",
  ],
  alternates: {
    canonical: "https://monad-tech.com/validators/compare",
  },
  openGraph: {
    title: "Compare Monad Validators",
    description: "Side-by-side metrics for delegation decisions.",
    url: "https://monad-tech.com/validators/compare",
    type: "website",
  },
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
