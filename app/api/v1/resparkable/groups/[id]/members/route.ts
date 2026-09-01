/**
 * GET /api/v1/resparkable/groups/[id]/members: who is in this group.
 *
 * There is no `POST` here, and its absence is the design. **A membership is
 * created by accepting an invitation and by nothing else** (§23.3): an admin
 * adding somebody by user id would be a route that puts a person into a shared
 * workspace without their consent, and the invitation is what makes consent a
 * step. Phase 57 adds the second route in, a join link, which is still the
 * invitee's own action.
 *
 * The list is the same one `GET /groups/[id]` returns, addressable on its own so
 * a member list can refresh without re-reading the group.
 *
 * Authentication: required. Membership is resolved through the one resolver, and
 * a non-member gets 404.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const resolved = await resolveGroupMembership(session.user.id, id);
  if (!resolved) throw new NotFoundError('Group not found');

  const members = await listGroupMembers(id);

  log.info('Resparkable group members list', { groupId: id, count: members.length });

  // No addresses. See `GET /groups/[id]` for why.
  return successResponse(
    members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    { count: members.length }
  );
});
