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
  ];
}
