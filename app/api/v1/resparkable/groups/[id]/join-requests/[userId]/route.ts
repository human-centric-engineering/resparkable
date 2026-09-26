/**
 * POST   /api/v1/resparkable/groups/[id]/join-requests/[userId]: let them in.
 * DELETE /api/v1/resparkable/groups/[id]/join-requests/[userId]: turn them down.
 *
 * A request is the pending membership row a `request` join link writes
 * (§23.11). Approving stamps `joinedAt`, under the group's row lock and with
 * the member cap re-checked, because approval is the second half of the link's
 * way in and without the re-check a `request` link would be a way round the cap.
 * Turning a request down deletes the row and keeps nothing.
 *
 * Somebody withdrawing their own request uses `DELETE /members/[their id]`,
 * which is the route they would use to leave.
 *
 * Authentication: required. Admin only.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import {
  approveGroupJoinRequest,
  rejectGroupJoinRequest,
  type JoinRequestRefusal,
} from '@/lib/framework/resparkable/services/group-join-links';

function refuse(reason: JoinRequestRefusal): never {
  if (reason === 'not_a_member') throw new NotFoundError('Group not found');
  if (reason === 'no_such_member') throw new NotFoundError('No such request to join');
  if (reason === 'group_full') {
    throw new ConflictError('The group is full. Raise its member limit to let them in.');
  }
  throw new ForbiddenError('Only an admin can answer a request to join');
}

export const POST = withAuth<{ id: string; userId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, userId } = await params;

    const result = await approveGroupJoinRequest(session.user.id, id, userId);
    if (!result.ok) refuse(result.reason);

    log.info('Resparkable group join request approved', { groupId: id });

    return successResponse({ userId, approved: true });
  }
);

export const DELETE = withAuth<{ id: string; userId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, userId } = await params;

    const result = await rejectGroupJoinRequest(session.user.id, id, userId);
    if (!result.ok) refuse(result.reason);

    log.info('Resparkable group join request rejected', { groupId: id });

    return successResponse({ userId, rejected: true });
  }
);
