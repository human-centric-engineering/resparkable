/**
 * DELETE /api/v1/resparkable/groups/[id]/invites/[inviteId]: withdraw one.
 *
 * **Idempotent, unlike revoking a grant.** A second revoke moves nothing and
 * still answers 200. The grant route is deliberately not idempotent, because a
 * grant can be re-issued and so a silent second success would be
 * indistinguishable from revoking one somebody had re-made in between. An
 * invitation is different: re-inviting the same address updates the same row
 * (`@@unique([groupId, email])`) and clears `revokedAt`, so there is no second
 * row a repeated DELETE could be confused about.
 *
 * Withdrawing takes effect immediately: acceptance is a compare-and-set on
 * `revokedAt IS NULL`, so a token in flight loses.
 *
 * Authentication: required. Admin only.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { revokeGroupInvite } from '@/lib/framework/resparkable/services/group-invites';

export const DELETE = withAuth<{ id: string; inviteId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, inviteId } = await params;

    const result = await revokeGroupInvite(session.user.id, id, inviteId);
    if (!result.ok) {
      if (result.reason === 'not_a_member') throw new NotFoundError('Group not found');
      throw new ForbiddenError('Only an admin can withdraw an invitation');
    }

    log.info('Resparkable group invite revoked', { groupId: id });

    return successResponse({ inviteId, revoked: true });
  }
);
