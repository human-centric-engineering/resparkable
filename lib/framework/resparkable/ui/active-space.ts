/**
 * Which workspace a request is for, and where that answer is written down.
 *
 * ## The URL is the authority
 *
 * §24.2 settles this: the active workspace is "held in the shell and in the
 * URL, never in a cookie alone". So it travels as one search param, `?space=`,
 * on both page URLs and API paths, and the absence of that param means the
 * personal space. Nothing reads it from a cookie, from `localStorage` or from
 * a module-level "current space", because every one of those is ambient state
 * that survives a back button, a second browser tab and a shared link, and
 * ambient state is exactly how a thought lands in the wrong brain.
 *
 * Three properties fall out of putting it in the URL, and all three are things
 * §24.2 asked for by name:
 *
 *   • a workspace is a link, so it can be bookmarked and pasted;
 *   • the browser back button walks between workspaces the way it walks
 *     between pages, because that is all a switch is;
 *   • two browser tabs can hold two different workspaces at once, with no
 *     shared state to fight over.
 *
 * ## A target, never an authority
 *
 * The value here is **untrusted**. It arrives from a link a stranger may have
 * sent, and it says only which space the caller would like. What decides
 * whether they may have it is `resolveActiveSpaceScope()` in
 * `services/membership.ts`, which reads membership and returns nothing at all
 * when the answer is no. Keeping the reader (here) and the resolver (there) in
 * two files with two vocabularies is deliberate: a "target" cannot be mistaken
 * for a "scope" at a call site.
 *
 * ## Client-safe
 *
 * Nothing in this file imports anything, for the same reason `routes.ts`
 * doesn't: it is read by `'use client'` components, by server pages and by
 * route handlers, and a single server-only import would poison the first of
 * those.
 *
 * @see .context/framework/resparkable/phase-46-plan.md: phase 47
 * @see .context/framework/resparkable/plan.md: §24.2
 */

/**
 * The one param name. Short because it is on every URL in the surface, and
 * spelled the same in a page URL and an API path so there is one thing to grep.
 */
export const SPACE_PARAM = 'space';

/**
 * Add the active space to a path, or leave the path alone.
 *
 * `null` is the personal space and is expressed by **absence**, never by
 * `?space=personal` or `?space=<userId>`. A magic string would be a second
 * spelling of the default that every reader would then have to handle, and a
 * user id in a URL is a user id in a server log, a referrer header and a
 * pasted link.
 *
 * Handles a path that already carries a query string, because several callers
 * pass one (`/resparkable/plan?day=...`, `RESPARKABLE_API.*` with filters).
 */
export function withSpace(path: string, spaceId: string | null | undefined): string {
  if (!spaceId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${SPACE_PARAM}=${encodeURIComponent(spaceId)}`;
}

/**
 * Read the target out of anything that carries search params.
 *
 * Three shapes reach this: a `URLSearchParams` (a route handler, or
 * `useSearchParams()` in the browser), the resolved `searchParams` object a
 * server page is handed, and `undefined` for a caller that has none. They are
 * one function rather than three because the rule they share is the one worth
 * having in a single place: an empty string, a repeated param and a missing
 * param all mean the personal space.
 *
 * A repeated `?space=a&space=b` resolves to nothing rather than to the first
 * value. Two answers to "which brain" is not a question with a sensible
 * default, and picking one would be a coin toss whose losing side is a
 * cross-space read attempt. It fails as a 404 on the personal space, which is
 * loud and harmless.
 */
export function readSpaceTarget(
  source: URLSearchParams | Record<string, string | string[] | undefined> | undefined
): string | null {
  if (!source) return null;

  const raw =
    source instanceof URLSearchParams ? source.getAll(SPACE_PARAM) : toArray(source[SPACE_PARAM]);

  if (raw.length !== 1) return null;

  const value = raw[0].trim();
  return value.length > 0 ? value : null;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
