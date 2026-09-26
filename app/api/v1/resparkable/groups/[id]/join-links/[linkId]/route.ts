/**
 * DELETE /api/v1/resparkable/groups/[id]/join-links/[linkId]: revoke a join link.
 *
 * Idempotent: a second revoke answers the same as the first. Takes effect
 * immediately, because redemption spends a use by compare-and-set on
 * `revokedAt IS NULL`, so a redemption in flight loses. Revoking a link does
 * not remove anybody who already joined through it; that is a separate act on
 * a named member.
 *
 * Authentication: required. Admin only.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { revokeGroupJoinLink } from '@/lib/framework/resparkable/services/group-join-links';

export const DELETE = withAuth<{ id: string; linkId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, linkId } = await params;

    const result = await revokeGroupJoinLink(session.user.id, id, linkId);
    if (!result.ok) {
      if (result.reason === 'not_a_member') throw new NotFoundError('Group not found');
      throw new ForbiddenError('Only an admin can revoke a join link');
    }

    log.info('Resparkable group join link revoked', { groupId: id });

    return successResponse({ linkId, revoked: true });
  }
);
