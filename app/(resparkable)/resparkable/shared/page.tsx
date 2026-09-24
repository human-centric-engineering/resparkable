import type { Metadata } from 'next';

import { SharedWithMeView } from '@/components/resparkable/share/shared-with-me-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { sharedWithMeListSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';
import {
  readResparkable,
  type ResparkableSearchParams,
} from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Shared with me',
  description: 'Items other people and groups have shared with you.',
};

/**
 * The one section of Resparkable that shows other people's material.
 *
 * It is a section rather than a filter on the existing lists, and that is a
 * design decision with three reasons behind it (§13), in weight order: it keeps
 * `WHERE userId = $1` an unconditional invariant on every other list, search
 * and embedding query in the tier; a second brain's lists are a *planning*
 * surface, and somebody else's project sitting in "my projects" corrupts your
 * own sense of what you have committed to; and mixing them in would make around
 * forty list endpoints potential leaks rather than the handful behind this one.
 *
 * Direct grants only. A shared project's tasks are reached by opening the
 * project — flattening the cascade here would answer "what has Priya given me?"
 * with two hundred rows when the honest answer is one project.
 */
export default async function ResparkableSharedPage({
  searchParams,
}: {
  searchParams: ResparkableSearchParams;
}) {
  const space = readSpaceTarget(await searchParams);
  // Per workspace since phase 49. Inside a group this is what was shared with
  // the group; in the personal workspace, what was shared with you. Neither list
  // shows the other's, which is test 13g: nothing crosses spaces implicitly.
  const shared = await readResparkable(RESPARKABLE_API.SHARED, sharedWithMeListSchema, space);

  if (!shared.ok) {
    return <LoadError what="what has been shared with you" message={shared.message} />;
  }

  return <SharedWithMeView items={shared.data} />;
}
