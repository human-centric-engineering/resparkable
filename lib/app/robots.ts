/**
 * App-owned crawler exclusions.
 *
 * **Fork-owned scaffold** — Resparkable ships this empty (`[]`) and does NOT
 * change it after release, so your edits merge cleanly on upgrade (the stable
 * contract is this export, not its value). Same model as
 * `lib/app/protected-routes.ts`: `app/robots.ts` merges these with the core
 * disallow list rather than a fork editing that file.
 *
 * Append a path prefix here when your fork adds a route that must not be
 * crawled. Note what `robots.txt` is and is not:
 *
 *   • It **is** the way to stop a well-behaved crawler discovering a URL that
 *     was posted somewhere public.
 *   • It is **advisory**, and it does **not** remove a URL that is already
 *     indexed. Anything that must not be indexed also needs `noindex` — in the
 *     page's `metadata.robots`, and as an `X-Robots-Tag` header on any API
 *     route serving the same content, since crawlers fetch those directly.
 *
 * A path listed here and nowhere else is a path you have asked politely about.
 *
 * Boundary-clean: a plain string array (no imports).
 */
export const appDisallowedPaths: string[] = [
  // Public share links (Release 2). Each URL is a bearer credential to one item
  // of one person's brain, so it is never something a search engine should hold
  // — and unlike everything else on this list, it is deliberately reachable
  // without a session. The header and metadata halves are set on
  // `app/api/v1/resparkable/public/[token]/route.ts` and `app/(public)/s/[token]/page.tsx`.
  '/s/',
];
