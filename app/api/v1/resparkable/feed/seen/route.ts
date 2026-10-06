/**
 * `POST /api/v1/resparkable/feed/seen`: mark the group feed read up to now
 * (§23.10, phase 59).
 *
 * The one non-`GET` a group viewer may make in a group, declared with
 * `{ access: 'read' }`: it writes the reader's own membership row and nothing
 * in the space (phase-58-59-plan.md Decision 1).
 */

import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { markFeedSeen } from '@/lib/framework/resparkable/services/feed';

export const POST = withAuth(async (request, session) => {
  const scope = await requestSpaceScope(request, session.user.id, { access: 'read' });
  const at = new Date();
  if (!(await markFeedSeen(scope, at))) {
    throw new NotFoundError('There is no activity feed in a personal workspace');
  }
  return successResponse({ seenAt: at });
});
