import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Incidents — Chronological Feed of Network Anomalies",
  description:
    "Unified chronological feed of Monad testnet anomalies: reorgs, validator churn " +
    "(added/removed/stake changes), retry spikes, block production stalls, critical logs. " +
    "Filter by severity (critical/warn/info) and time range (1h/6h/12h/24h/7d).",
  keywords: [
    "Monad incidents", "reorgs", "block stalls", "retry spikes", "validator churn",
    "network anomalies", "testnet issues", "critical logs",
  ],
  alternates: {
    canonical: "https://monad-tech.com/incidents",
  },
  openGraph: {
    title: "Monad Incident Timeline",
    description:
      "Unified feed: reorgs · validator churn · retry spikes · block stalls · critical logs. " +
      "Persistent across restarts.",
    url: "https://monad-tech.com/incidents",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Monad Incident Timeline",
    description: "Reorgs, retry spikes, block stalls, validator churn — one feed.",
  },
};

export default function IncidentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
