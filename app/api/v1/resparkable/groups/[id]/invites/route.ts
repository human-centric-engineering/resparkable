/**
 * GET  /api/v1/resparkable/groups/[id]/invites: outstanding invitations.
 * POST /api/v1/resparkable/groups/[id]/invites: invite somebody.
 *
 * ## This invitation grants nothing until it is accepted
 *
 * That is the difference from `/grants/[id]/invite`, and it is worth stating on
 * the route because the two look alike. A share grant is **already live** for
 * the address it names, and its invite only binds an account to it. A group
 * invitation is inert: `resolveGroupSpaceScope` reads memberships and nothing
 * else, so an invited address resolves to no scope at all until the token is
 * accepted and a membership row exists.
 *
 * ## The response says nothing about whether the address has an account
 *
 * §13's rule, and it matters at least as much here: anything distinguishable
 * turns "invite somebody" into an account-existence oracle anybody can query one
 * address at a time. `sent` reports only whether an email left the building.
 *
 * ## Rate limiting
 *
 * `resparkable-invite`, 20/day keyed on the session user, matched on the
 * `/invites` suffix in `lib/framework/resparkable/rate-limit.ts`. Same tier as
 * the share invite and for the same reason: this costs the deployment almost
 * nothing and lands in somebody else's inbox, so the cap is about not being a
 * spam cannon with the deployment's domain attached. Applied by the middleware,
 * never called from here.
 *
 * Authentication: required. Admin only, and the check is in the service so the
 * join-link path phase 57 adds inherits it.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  issueGroupInvite,
  listInvitesForAdmin,
  type InviteRefusal,
} from '@/lib/framework/resparkable/services/group-invites';
import { createGroupInviteSchema } from '@/lib/framework/resparkable/validations';

function refuse(reason: InviteRefusal): never {
  if (reason === 'not_a_member') throw new NotFoundError('Group not found');
  throw new ForbiddenError('Only an admin can invite people to a group');
}

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const result = await listInvitesForAdmin(session.user.id, id);
  if (!result.ok) refuse(result.reason);

  // Addresses ARE returned here, unlike the member list, and the difference is
  // real: an outstanding invitation is addressed to a mailbox and nothing else,
  // so an admin who cannot see the address cannot tell what they invited or
  // withdraw it. A member has an account the client can name another way.
  log.info('Resparkable group invites list', { groupId: id, count: result.invites.length });

  return successResponse(result.invites, { count: result.invites.length });
});

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, createGroupInviteSchema);

  const result = await issueGroupInvite(session.user.id, id, body);
  if (!result.ok) refuse(result.reason);

  // No address in the log line. One person's contact details in another
  // person's infrastructure, for the life of the log.
  log.info('Resparkable group invite issued', { groupId: id, role: body.role, sent: result.sent });

  return successResponse({ inviteId: result.inviteId, sent: result.sent }, undefined, {
    status: 201,
  });
});
