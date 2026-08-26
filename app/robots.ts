import type { MetadataRoute } from 'next';

import { appDisallowedPaths } from '@/lib/app/robots';

/**
 * Robots.txt Configuration
 *
 * Controls how search engine crawlers access the site.
 * - Allows all crawlers to access public pages
 * - Blocks access to API routes and auth pages
 * - References the sitemap for discovery
 *
 * A fork adds its own exclusions through the fork-owned `appDisallowedPaths`
 * (`lib/app/robots.ts`) rather than editing the literal below — the same seam
 * model as `appProtectedRoutes` in `proxy.ts`. The two are merged; core's
 * entries always stay.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin/',
          '/dashboard/',
          '/settings/',
          '/profile/',
          '/login',
          '/signup',
          // Fork-owned, appended. Normalised the same way `proxy.ts` normalises
          // `appProtectedRoutes`: anything that is not a non-empty `/`-prefixed
          // path is dropped, so a stray `''` cannot become a site-wide
          // disallow.
          ...appDisallowedPaths.filter((path) => path.startsWith('/') && path.length > 1),
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
