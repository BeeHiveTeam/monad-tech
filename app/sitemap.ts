import { MetadataRoute } from 'next';

const BASE_URL = 'https://monad-tech.com';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE_URL,
      changeFrequency: 'always',
      priority: 1,
    },
    {
      url: `${BASE_URL}/validators`,
      changeFrequency: 'always',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/network`,
      changeFrequency: 'always',
      priority: 0.8,
    },
  ];
}
