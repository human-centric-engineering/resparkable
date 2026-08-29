/**
 * GET /api/v1/resparkable/shared — what other people have shared with me.
 *
 * The one read surface in the tier that crosses a person, and the reason it is
 * its own route prefix rather than a flag on the owner's lists: shared-in items
 * must never appear in `/tasks`, `/projects` or `/search`, so that
 * `WHERE userId = $1` stays an unconditional invariant on all forty of them
 * (§13). Mixing them in would make every list a potential leak; keeping them
 * here makes it these few.
 *
 * **Direct grants only.** A shared project's tasks are reached by opening the
 * project. A list that flattened the cascade would answer "what has Priya given
 * me?" with two hundred rows when the honest answer is one project.
 *
 * **There are no write paths under `/shared`, and there must not be.** A grant
 * is `viewer` or `commenter`; neither implies any authority over the item.
 * Comments (phase 13) write to their own table through their own route.
 *
 * Authentication: required. The viewer is built from the session and nothing
 * else — an email or a user id from the request body would be the whole ball
 * game.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { listSharedWithMe } from '@/lib/framework/resparkable/services/shared-with-me';
import { sharedListQuerySchema } from '@/lib/framework/resparkable/validations';
import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const query = validateQueryParams(new URL(request.url).searchParams, sharedListQuerySchema);

  const items = await listSharedWithMe(viewerFromSession(session), query);

  log.info('Resparkable shared-with-me list', { count: items.length });

  return successResponse(items, { count: items.length });
});
