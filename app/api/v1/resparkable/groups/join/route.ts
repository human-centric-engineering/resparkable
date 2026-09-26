/**
 * POST /api/v1/resparkable/groups/join: redeem a join link.
 *
 * ## What the token gets you
 *
 * For an `open` link, membership now, at the role the link was minted with. For
 * a `request` link, a pending row that resolves to no scope at all until an
 * admin approves it, so this call reads nothing in the group either way. It
 * cannot confer `admin`: no link carries it.
 *
 * ## Every bad token gives one answer
 *
 * Malformed, unknown, expired, revoked and used up are all `outcome:
 * 'unknown'` (a malformed one is a 400 first, which the page renders the same). A full group is the one failure that explains itself,
 * because the holder of a live link is somebody an admin chose to let knock.
 *
 * ## Not under `/groups/[id]/`
 *
 * The token names the group, as with `/groups/invites/accept`.
 *
 * ## Rate limiting
 *
 * `resparkable-join`, 30/day on the session user, applied by the middleware.
 * The token is a path a signed-in stranger presents; 192 bits is the real
 * defence, and the cap is so that a loop cannot make the attempt at all.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { redeemJoinLinkToken } from '@/lib/framework/resparkable/services/group-join-links';
import { redeemJoinLinkSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, redeemJoinLinkSchema);

  const result = await redeemJoinLinkToken(session.user.id, body.token);

  // A 200 whatever happened, matching the invite flow: an expired link is an
  // ordinary answer, not a fault for the error monitoring. One `outcome` field
  // rather than a `joined` flag, because a request to join is neither joined nor
  // refused, and a boolean would have to lie about one of them.
  if (!result.ok) {
    log.info('Resparkable group join link not redeemed', { reason: result.reason });
    return successResponse({
      outcome: result.reason,
      ...(result.reason === 'group_full' ? { groupName: result.groupName } : {}),
    });
  }

  log.info('Resparkable group join link redeemed', {
    groupId: result.groupId,
    outcome: result.outcome,
  });

  return successResponse({
    outcome: result.outcome,
    groupId: result.groupId,
    groupName: result.groupName,
  });
});
