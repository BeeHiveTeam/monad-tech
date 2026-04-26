import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Validators — Health Score, Stake, Commission",
  description:
    "Complete list of Monad validators with health scoring, stake, commission, " +
    "uptime participation, block production, and transaction volume. Sortable, " +
    "filterable by registered-only, with composite score (40% health + 40% uptime + 20% recency).",
  keywords: [
    "Monad validators", "validator list", "validator health", "validator stake",
    "validator commission", "uptime", "block production", "Nakamoto",
    "staking validators", "delegation candidates",
  ],
  alternates: {
    canonical: "https://monad-tech.com/validators",
  },
  openGraph: {
    title: "Monad Validators — Health Score & Stake Distribution",
    description:
      "316+ Monad validators ranked by composite health score. Live uptime, " +
      "stake, commission. Filterable by registered-only.",
    url: "https://monad-tech.com/validators",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Monad Validators — Health & Stake",
    description: "316+ validators with health scoring, live uptime, stake & commission.",
  },
};

export default function ValidatorsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
