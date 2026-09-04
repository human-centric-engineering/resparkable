'use client';

/**
 * The active workspace, for things rendered rather than fetched.
 *
 * ## Why this exists beside `withActiveSpace`
 *
 * Two readers of one value, split by *when* they read it, and the split is not
 * a preference:
 *
 *   • `withActiveSpace` (in `api/client.ts`) reads `window.location` and is for
 *     things that happen when a person acts: a fetch, a `router.push`. There is
 *     no server render at that moment and the address bar is the freshest
 *     possible answer.
 *   • This hook reads `useSearchParams()` and is for things that appear in the
 *     markup: an `href`, a label. Those are rendered on the server first, where
 *     there is no `window` at all, and an `href` that gained a `?space=` only
 *     after hydration would be a mismatch React logs and a link that means two
 *     different things depending on how fast you click it.
 *
 * Same param, same rules, same file behind both (`active-space.ts`).
 *
 * ## Preserving the workspace across navigation
 *
 * Every in-app link and every `router.push` has to carry the workspace, or the
 * first navigation silently drops the user back into their personal brain.
 * That is the least interesting failure in this phase and the easiest to ship:
 * the switcher works, the page loads, and the content is wrong.
 *
 * @see lib/framework/resparkable/ui/active-space.ts
 */

import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { readSpaceTarget, withSpace } from '@/lib/framework/resparkable/ui/active-space';

/**
 * Returns a function that adds the active workspace to a path.
 *
 * A function rather than the id itself, because every call site wants the same
 * three lines afterwards, and one of them would eventually write them
 * differently.
 */
export function useSpaceHref(): (path: string) => string {
  const searchParams = useSearchParams();
  const space = readSpaceTarget(searchParams);

  return React.useCallback((path: string) => withSpace(path, space), [space]);
}

/** The active workspace's id, or `null` for the personal space. */
export function useActiveSpaceId(): string | null {
  return readSpaceTarget(useSearchParams());
}
