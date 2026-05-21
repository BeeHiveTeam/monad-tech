import { MetadataRoute } from 'next';

const BASE_URL = 'https://monad-tech.com';

// Lists every publicly crawlable page. Auth-gated routes (/node, /admin) are
// intentionally excluded — they return 401 and wouldn't be useful to a
// search crawler anyway. Detail pages (/validators/[address], /block/[n],
// /tx/[hash]) are dynamic and expanded by the live RPC; no value in listing
// them as a static sitemap.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: BASE_URL,
      lastModified: now,
      changeFrequency: 'always',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/validators`,
      lastModified: now,
      changeFrequency: 'always',
      priority: 0.9,
    },
    {
      // /delegate redirects to /validators?view=delegator (audit 2026-05-21
      // merged the picker into the validators table as a view mode).
      // Canonical URL is the validators one with the query param.
      url: `${BASE_URL}/validators?view=delegator`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/my-delegations`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/network`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/incidents`,
      lastModified: now,
      changeFrequency: 'always',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/beehive`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/network/concentration`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/validators/compare`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/tools`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/tools/rpcs`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/tools/scripts`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/tools/monitoring`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
  ];
}
