import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "BeeHive — Monad Validator Operator",
  description:
    "BeeHive is a professional Monad validator operator. Live infrastructure telemetry: " +
    "client version, sync status, peer count, services health. Transparent operations, " +
    "open observability via monad-tech.com. Delegate your MON to a battle-tested node operator.",
  keywords: [
    "BeeHive validator", "Monad validator operator", "delegation", "staking",
    "node operator", "Lido DVT", "Obol", "SSV", "Mina Protocol",
    "Provenance", "Stellar Lumen", "99.9% uptime",
  ],
  alternates: {
    canonical: "https://monad-tech.com/beehive",
  },
  openGraph: {
    title: "Delegate to BeeHive — Monad Validator Operator",
    description:
      "Professional Monad validator with live infra telemetry, transparent operations, " +
      "multi-chain experience (Lido, Mina, Provenance, Stellar).",
    url: "https://monad-tech.com/beehive",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Delegate to BeeHive",
    description: "Professional Monad validator. Live telemetry. Transparent operations.",
  },
};

export default function BeeHiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
