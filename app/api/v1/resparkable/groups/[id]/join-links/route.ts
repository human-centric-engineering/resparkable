/**
 * GET  /api/v1/resparkable/groups/[id]/join-links: the group's join links.
 * POST /api/v1/resparkable/groups/[id]/join-links: mint one.
 *
 * ## A forwarded join link is the whole thing
 *
 * Unlike an invitation, a join link names nobody: whoever holds it and is
 * signed in can use it. So it gets §13's public-link treatment (§23.11): 192
 * bits, sha256 at rest, an expiry, revocation, a use limit, and a role fixed at
 * mint that **can never be `admin`**. That last rule is asserted here, by the
 * schema, and again in `mintJoinLink`, so it does not depend on the UI.
 *
 * The token is in the POST response and nowhere else, ever. The list shows a
 * prefix.
 *
 * ## Rate limiting
 *
 * `POST` is on `resparkable-join-link`, 20/day on the session user, because an
 * unbounded set of live links is an unbounded set of credentials to one
 * workspace. `GET` skips that rule and falls through to the section's 100/min,
 * so an admin loading the page does not spend it. Both applied by the
 * middleware (`lib/framework/resparkable/rate-limit.ts`), never called here.
 *
 * Authentication: required. Admin only, checked in the service.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  listJoinLinksForAdmin,
  mintJoinLink,
  type JoinLinkRefusal,
} from '@/lib/framework/resparkable/services/group-join-links';
import { createJoinLinkSchema } from '@/lib/framework/resparkable/validations';

function refuse(reason: JoinLinkRefusal): never {
  if (reason === 'not_a_member') throw new NotFoundError('Group not found');
  if (reason === 'admin_link') {
    throw new ValidationError('A join link cannot make somebody an admin', {
      role: ['Choose member or viewer'],
    });
  }
  throw new ForbiddenError('Only an admin can manage join links');
}

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const result = await listJoinLinksForAdmin(session.user.id, id);
  if (!result.ok) refuse(result.reason);

  log.info('Resparkable group join links list', { groupId: id, count: result.links.length });

  return successResponse(result.links, { count: result.links.length });
});

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, createJoinLinkSchema);

  const result = await mintJoinLink(session.user.id, id, body);
  if (!result.ok) refuse(result.reason);

  // Never the token or the URL in a log line: either one is the credential.
  log.info('Resparkable group join link minted', {
    groupId: id,
    role: result.link.role,
    approval: result.link.approval,
  });

  return successResponse({ ...result.link, token: result.token, url: result.url }, undefined, {
    status: 201,
  });
});
