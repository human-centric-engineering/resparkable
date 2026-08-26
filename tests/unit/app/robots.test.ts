/**
 * Unit Tests: `app/robots.ts` and the fork-owned exclusion seam.
 *
 * `robots.txt` is the weakest of the three anti-indexing measures on a public
 * share link, and it is the only one that stops a well-behaved crawler
 * *discovering* the URL in the first place — the other two (`noindex` in the
 * page metadata, `X-Robots-Tag` on the API route) only take effect once
 * something has already fetched it, and neither removes a URL that is already
 * indexed. All three are required; this covers the one that lives here.
 *
 * The seam matters as much as the entry. A fork adding a route that must not be
 * crawled should append to `lib/app/robots.ts`, not edit this file — the same
 * model as `appProtectedRoutes` in `proxy.ts`, and for the same reason: a fork
 * editing a core file is a merge conflict inflicted on every host project.
 *
 * @see app/robots.ts
 * @see lib/app/robots.ts
 */

import { describe, expect, it } from 'vitest';

import robots from '@/app/robots';
import { appDisallowedPaths } from '@/lib/app/robots';

describe('robots.txt', () => {
  const rule = () => {
    const [first] = robots().rules as Array<{ disallow?: string[] }>;
    return first;
  };

  it('disallows the public share reader', () => {
    expect(rule().disallow).toContain('/s/');
  });

  it('keeps every core exclusion', () => {
    // The seam appends; it never replaces. A fork must not be able to open the
    // admin surface to crawlers by supplying its own list.
    expect(rule().disallow).toEqual(
      expect.arrayContaining(['/api/', '/admin/', '/dashboard/', '/settings/', '/profile/'])
    );
  });

  it('includes every fork-owned path', () => {
    for (const path of appDisallowedPaths) {
      expect(rule().disallow).toContain(path);
    }
  });

  it('drops an entry that would disallow the whole site', () => {
    // The failure this guards is total and silent: a stray `''` or a lone `/`
    // in the fork list would de-index the entire deployment, and nothing about
    // the generated file would look wrong at a glance. `proxy.ts` normalises
    // `appProtectedRoutes` the same way for the mirror-image reason.
    const disallow = rule().disallow ?? [];
    expect(disallow).not.toContain('');
    expect(disallow).not.toContain('/');
  });
});
