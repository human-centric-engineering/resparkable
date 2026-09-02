/**
 * PATCH  /api/v1/resparkable/groups/[id]/members/[userId]: change a role.
 * DELETE /api/v1/resparkable/groups/[id]/members/[userId]: remove, or leave.
 *
 * ## One route for "remove them" and "leave"
 *
 * They are the same write with different authority: an admin removing somebody
 * else, or anybody removing themselves. `services/membership.ts` decides which
 * of those the request is, and applies the last-admin rule to both. Splitting
 * them into two routes would leave two places for that rule to be forgotten in,
 * and the leave path is where forgetting it is likeliest.
 *
 * ## The last admin
 *
 * Cannot be demoted, cannot be removed, and cannot leave (§23.3). A group with
 * no admin is a workspace nobody can administer, holding content nobody can
 * export. The refusal is a 409 rather than a 403: nothing is wrong with the
 * caller's authority, the group is in a state where the change is not available,
 * and the UI's answer is "promote somebody first" rather than "you may not".
 *
 * The exception is the last MEMBER leaving, which is allowed and deletes the
 * group. Refusing would trap the last person in a group for ever.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  changeMemberRole,
  removeMember,
  type MembershipRefusal,
} from '@/lib/framework/resparkable/services/membership';
import { updateGroupMemberSchema } from '@/lib/framework/resparkable/validations';

/**
 * One refusal vocabulary, one place it becomes an HTTP status.
 *
 * `not_a_member` is a 404 rather than a 403, because a 403 confirms the group
 * exists to somebody who guessed an id. Everything else is answered to a caller
 * who is already in the group and can be told the truth.
 */
function refuse(reason: MembershipRefusal): never {
  switch (reason) {
    case 'not_a_member':
      throw new NotFoundError('Group not found');
    case 'no_such_member':
      throw new NotFoundError('That person is not in this group');
    case 'not_an_admin':
      throw new ForbiddenError('Only an admin can do that');
    case 'last_admin':
      throw new ConflictError('This is the group’s only admin. Make somebody else an admin first.');
    case 'unknown_role':
      throw new ValidationError('Unknown role');
  }
}

export const PATCH = withAuth<{ id: string; userId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, userId } = await params;

    const body = await validateRequestBody(request, updateGroupMemberSchema);

    const result = await changeMemberRole(session.user.id, id, userId, body.role);
    if (!result.ok) refuse(result.reason);

    log.info('Resparkable group member role changed', { groupId: id, role: body.role });

    return successResponse({ groupId: id, role: body.role });
  }
);

export const DELETE = withAuth<{ id: string; userId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, userId } = await params;

    const result = await removeMember(session.user.id, id, userId);
    if (!result.ok) refuse(result.reason);

    if (result.value.groupDeleted) {
      log.warn('Resparkable group deleted: its last member left', { groupId: id });
    } else {
      log.info('Resparkable group member removed', { groupId: id });
    }

    // The client needs to know the group is gone, or it renders a member list
    // for a workspace that no longer exists.
    return successResponse({ groupId: id, groupDeleted: result.value.groupDeleted });
  }
);
