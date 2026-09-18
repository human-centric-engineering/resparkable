/**
 * `GET /api/v1/resparkable/spaces` — what the switcher shows.
 *
 * Keyed on the actor rather than on a workspace, and therefore one of the few
 * routes in the tier that does NOT call `requestSpaceScope`: "which workspaces
 * can I open" is a question about a person, and answering it from inside one
 * workspace would be circular.
 *
 * It reads no brain content. Names, kinds and roles only, which is what a
 * switcher needs and the most this endpoint should ever return: the moment it
 * carries a count or a preview it becomes a read of every workspace on every
 * page load.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { listOpenableSpaces } from '@/lib/framework/resparkable/services/spaces';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const spaces = await listOpenableSpaces(session.user.id);

  log.info('Resparkable spaces listed', { count: spaces.length });

  return successResponse(spaces);
});
