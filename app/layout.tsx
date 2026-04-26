import type { Metadata } from "next";
import "./globals.css";
import AnalyticsTracker from "@/components/AnalyticsTracker";
import { Suspense } from "react";

const SITE_URL = "https://monad-tech.com";
const SITE_NAME = "Monad Tech";
const SITE_TITLE = "Monad Tech — Network Monitor & Validator Observability";
const SITE_DESCRIPTION =
  "Real-time Monad testnet observability: parallel execution metrics (retry_pct), " +
  "validator health scoring, network decentralization (Nakamoto coefficient), peer geo, " +
  "reorgs, incident timeline. Operated by BeeHive.";
const OG_IMAGE = `${SITE_URL}/og-image.svg`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s · Monad Tech",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "Monad", "Monad testnet", "Monad mainnet", "Monad blockchain",
    "validator", "validator monitoring", "validator metrics", "validator health",
    "parallel execution", "retry_pct", "MonadBFT",
    "Nakamoto coefficient", "decentralization",
    "block explorer", "crypto dashboard", "node operator",
    "staking", "delegation", "BeeHive",
  ],
  authors: [{ name: "BeeHive", url: "https://bee-hive.work" }],
  creator: "BeeHive Team",
  publisher: "BeeHive",

  alternates: {
    canonical: SITE_URL,
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },

  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Monad Tech — Real-time Monad Network Observability Dashboard",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    site: "@BeeHive_NT",
    creator: "@BeeHive_NT",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },

  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/beehive-logo.svg", type: "image/svg+xml" },
    ],
    apple: "/beehive-logo.svg",
  },

  manifest: "/manifest.json",

  applicationName: SITE_NAME,
  category: "technology",
  classification: "Blockchain Infrastructure",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#080808",
  colorScheme: "dark",
};

// JSON-LD structured data — helps Google understand site purpose, surfaces
// rich results, tells social crawlers who the operator is. Three entities:
// Organization (BeeHive), WebSite (Monad Tech), SoftwareApplication (the app).
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "BeeHive",
      alternateName: "BeeHive Node Infrastructure",
      url: "https://bee-hive.work",
      logo: `${SITE_URL}/beehive-logo.svg`,
      description:
        "Professional blockchain validator operator running infrastructure across Lido, " +
        "Obol, SSV, Mina, Provenance, Stellar, and Monad.",
      sameAs: [
        "https://x.com/BeeHive_NT",
        "https://github.com/BeeHiveTeam",
      ],
      knowsAbout: [
        "Blockchain Validator Operations",
        "Monad Protocol",
        "Parallel Execution",
        "MonadBFT Consensus",
        "Staking Infrastructure",
        "Node Monitoring",
      ],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en-US",
      potentialAction: {
        "@type": "SearchAction",
        target: `${SITE_URL}/validators?search={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Blockchain Observability",
      operatingSystem: "Web",
      url: SITE_URL,
      description:
        "Real-time Monad testnet observability dashboard with parallel-execution " +
        "metrics, incident timeline, and validator health scoring.",
      author: { "@id": `${SITE_URL}/#organization` },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Real-time TPS and gas metrics",
        "Parallel execution retry_pct analytics",
        "Unified incident timeline",
        "Validator health scoring",
        "Network decentralization metrics (Nakamoto coefficient)",
        "Peer geolocation distribution",
        "Block execution time breakdown",
        "Top contracts by parallelism conflicts",
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500&family=DM+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Preload the bee logo (used on most pages) */}
        <link rel="preload" href="/beehive-logo.svg" as="image" type="image/svg+xml" />
        {/* JSON-LD structured data for search engines */}
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body>
        <Suspense fallback={null}><AnalyticsTracker /></Suspense>
        {children}
        {/* Cloudflare Web Analytics — RUM + Core Web Vitals */}
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "786ed0bbe18c4f879856da3c8cf8131d"}'
        />
      </body>
    </html>
  );
}
