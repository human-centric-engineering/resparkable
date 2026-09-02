/**
 * POST /api/v1/resparkable/groups/invites/accept: join a group.
 *
 * ## The token names the invitation; the session proves the address
 *
 * Both are required and neither is sufficient. A forwarded email is useless
 * because accepting needs a session on the address the invitation names; a
 * session alone is useless because membership is never resolved by email
 * anywhere in this tier. That pair is the whole authentication design, and it is
 * the same one `/invites/accept` uses for a share.
 *
 * ## Every failure gives one answer
 *
 * A malformed token, an unknown one, a withdrawn invitation, an expired one and
 * one already spent all return the same `unknown`. Anything distinguishable
 * turns this endpoint into an oracle about which invitations once existed, and
 * here it would also enumerate which groups do.
 *
 * The one exception is a signed-in reader whose address does not match, who is
 * told which address it was for, **masked**. They need enough to recognise their
 * own mailbox and a stranger must not be handed a working address.
 *
 * ## Not under `/groups/[id]/`
 *
 * Deliberately: the caller does not know the group id, and requiring it would
 * mean a route that says "wrong group" for the right token, which is an
 * enumeration surface. The token resolves the group.
 *
 * Authentication: required. Rate limiting: the section's 100/min. This route
 * sends no mail and does no expensive work; the guessing risk it carries is
 * answered by 192 bits of token, not by a cap.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { acceptGroupInvite } from '@/lib/framework/resparkable/services/group-invites';
import { acceptGroupInviteSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, acceptGroupInviteSchema);

  const result = await acceptGroupInvite(
    { userId: session.user.id, email: session.user.email },
    body.token
  );

  // A 200 with `joined: false` rather than a 4xx, matching the share-accept
  // flow. The page renders a reason either way, and an HTTP error would put an
  // ordinary "this link has expired" into the error monitoring alongside real
  // faults.
  //
  // The wire shape is flat and tagged by `joined`, rather than the service's
  // discriminated union, for the reason `acceptInviteResponseSchema` gives about
  // its own: the page reads the tag first and nothing else matters until it has.
  if (!result.ok) {
    log.info('Resparkable group invite not accepted', { reason: result.reason });
    return successResponse({
      joined: false,
      reason: result.reason,
      ...(result.reason === 'wrong_account' ? { expectedEmail: result.expectedEmail } : {}),
    });
  }

  log.info('Resparkable group invite accepted', { groupId: result.groupId });

  return successResponse({
    joined: true,
    groupId: result.groupId,
    groupName: result.groupName,
    spaceId: result.spaceId,
    alreadyMember: result.alreadyMember,
  });
});
