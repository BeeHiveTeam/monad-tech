import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Network Health — Decentralization, Reorgs, Peer Geo",
  description:
    "Monad network decentralization metrics: Nakamoto coefficient at 33%/50%/66% thresholds, " +
    "top-10 stake concentration, peer geographical distribution by country/ASN, reorg detection, " +
    "and validator set changes. Data not available in official tools.",
  keywords: [
    "Monad decentralization", "Nakamoto coefficient", "reorgs", "peer geo",
    "validator set changes", "stake distribution", "ASN distribution",
    "network health", "MonadBFT",
  ],
  alternates: {
    canonical: "https://monad-tech.com/network",
  },
  openGraph: {
    title: "Monad Network Health — Decentralization & Reorgs",
    description:
      "Nakamoto coefficient, peer geo, reorg detection, validator churn — " +
      "metrics not exposed by official Monad tools.",
    url: "https://monad-tech.com/network",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Monad Network Health",
    description: "Nakamoto coefficient, peer geo, reorgs, validator churn — decentralization metrics.",
  },
};

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
