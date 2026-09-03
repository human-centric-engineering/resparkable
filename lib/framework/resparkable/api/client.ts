'use client';

/**
 * The browser's API client for Resparkable, and the one place a client
 * component's request learns which workspace it is in.
 *
 * ## Why a wrapper rather than forty call sites
 *
 * Forty components in this tier call `apiClient` directly. Every one of them
 * would otherwise have to receive the active workspace as a prop, thread it
 * through whatever hook owns the fetch, and remember to append it, and the
 * failure mode of forgetting one is silent: the component reads the personal
 * space while the switcher says "Study Group B", renders content that looks
 * entirely plausible, and nobody finds out. That is the same argument that made
 * `readResparkable`'s `space` parameter required on the server, answered the
 * other way round because a client component *can* read the URL and a server
 * one cannot.
 *
 * ## Read from the URL, at call time
 *
 * `window.location.search` rather than a React context, a module-level
 * variable or a cookie. §24.2 makes the URL the authority, and the URL is the
 * only one of those four that cannot go stale: a context has to be re-rendered
 * into, a module variable outlives a client-side navigation, and a cookie
 * outlives the tab. Reading at call time means the request carries whatever
 * workspace the address bar showed at the moment the user acted, which is the
 * one answer that matches what they were looking at.
 *
 * ## What must not use this
 *
 * **Capture.** Quick capture, the share target, voice and image all default to
 * the personal space and take an explicit target instead, because ambient state
 * is exactly how a thought lands in the wrong brain (§23.4, test 13e). Those
 * paths call `apiClient` directly with a `spaceId` in the body, and the
 * difference is deliberate rather than an oversight: this file is for reading a
 * workspace you are looking at, not for choosing one to write into.
 *
 * `apiClient` is core's and unchanged. This adds one query param and forwards
 * everything else, so a caller keeps core's params, body, headers and error
 * behaviour exactly.
 *
 * @see lib/framework/resparkable/ui/active-space.ts
 * @see .context/framework/resparkable/phase-46-plan.md: decision 12
 */

import { apiClient } from '@/lib/api/client';
import { readSpaceTarget, withSpace } from '@/lib/framework/resparkable/ui/active-space';

type GetOptions = Parameters<typeof apiClient.get>[1];
type MutateOptions = Parameters<typeof apiClient.post>[1];

/**
 * Add the address bar's workspace to a path.
 *
 * Exported because a few callers build a URL for something other than
 * `apiClient` (an `EventSource`, a download `<a href>`), and those need the
 * same answer from the same place rather than a second reading of the URL.
 */
export function withActiveSpace(path: string): string {
  // SSR and the initial render of a client component both run without a
  // `window`. Returning the bare path is right there: nothing fetches during
  // that pass, and a component that somehow did would be asking for the
  // personal space, which is the safe half of the two possible mistakes.
  if (typeof window === 'undefined') return path;

  return withSpace(path, readSpaceTarget(new URLSearchParams(window.location.search)));
}

/**
 * An omitted argument stays omitted.
 *
 * `apiClient.get(path)` and `apiClient.get(path, undefined)` do the same thing,
 * but they are not the same call, and a wrapper that quietly turned the first
 * into the second would rewrite the shape of every call in the tier for no
 * reason. Forwarding nothing when nothing was passed keeps this file a
 * pass-through rather than a second client with its own habits.
 */
function optional<T>(value: T | undefined): [] | [T] {
  return value === undefined ? [] : [value];
}

/**
 * `apiClient`, with the active workspace on every path.
 *
 * The method names and signatures are core's, so a call site changes by its
 * import and nothing else.
 */
export const resparkableApi = {
  get: <T>(path: string, options?: GetOptions): Promise<T> =>
    apiClient.get<T>(withActiveSpace(path), ...optional(options)),
  post: <T>(path: string, options?: MutateOptions): Promise<T> =>
    apiClient.post<T>(withActiveSpace(path), ...optional(options)),
  put: <T>(path: string, options?: MutateOptions): Promise<T> =>
    apiClient.put<T>(withActiveSpace(path), ...optional(options)),
  patch: <T>(path: string, options?: MutateOptions): Promise<T> =>
    apiClient.patch<T>(withActiveSpace(path), ...optional(options)),
  delete: <T = void>(path: string, options?: MutateOptions): Promise<T> =>
    apiClient.delete<T>(withActiveSpace(path), ...optional(options)),
};
