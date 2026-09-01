/**
 * GET    /api/v1/resparkable/groups/[id]: the group, and who is in it.
 * PATCH  /api/v1/resparkable/groups/[id]: name, description, member cap.
 * DELETE /api/v1/resparkable/groups/[id]: delete it and everything in it.
 *
 * ## 404, never 403
 *
 * Every refusal that turns on membership answers 404. A 403 confirms the group
 * exists to somebody who guessed an id, which is the same reasoning every read
 * in this tier gives and matters more here: a group name is a thing people can
 * be identified through.
 *
 * Refusals that turn on the caller's ROLE are different and answer 403, because
 * the caller already knows the group exists (they are in it) and "you are not an
 * admin" is a sentence the UI has to be able to show.
 *
 * ## DELETE is unrecoverable and affects people who are not the actor
 *
 * It removes the space, which cascades the whole brain, the group, its
 * memberships and its outstanding invitations. §23.6 gates it behind the same
 * explicitness §13 demands for a never-expiring share link: a typed confirmation
 * naming the group, plus a notification to every member. **Both are phase 48's
 * and neither is here yet**, so this route is admin-only and does the cascade,
 * and the client must not offer it as a menu item beside "leave group" until
 * that phase lands.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import {
  deleteGroup,
  resolveGroupMembership,
  updateGroupSettings,
} from '@/lib/framework/resparkable/services/membership';
import { updateGroupSchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const resolved = await resolveGroupMembership(session.user.id, id);
  if (!resolved) throw new NotFoundError('Group not found');

  const members = await listGroupMembers(id);

  log.info('Resparkable group read', { groupId: id, members: members.length });

  return successResponse({
    group: {
      groupId: resolved.membership.groupId,
      name: resolved.membership.group.name,
      slug: resolved.membership.group.slug,
      description: resolved.membership.group.description,
      spaceId: resolved.membership.group.spaceId,
      maxMembers: resolved.membership.group.maxMembers,
    },
    yourRole: resolved.membership.role,
    // Members by user id and role, and no addresses. Every member can see who
    // else is in the group, which §23.4 makes unavoidable and correct; handing
    // out everybody's email address is a separate decision nobody made. The
    // client resolves display names through the platform's own user surface.
    members: members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
  });
});

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, updateGroupSchema);

  const result = await updateGroupSettings(session.user.id, id, body);
  if (!result.ok) {
    if (result.reason === 'not_a_member') throw new NotFoundError('Group not found');
    throw new ForbiddenError('Only an admin can change a group’s settings');
  }

  log.info('Resparkable group updated', { groupId: id, fields: Object.keys(body) });

  return successResponse({ groupId: id });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const result = await deleteGroup(session.user.id, id);
  if (!result.ok) {
    if (result.reason === 'not_a_member') throw new NotFoundError('Group not found');
    throw new ForbiddenError('Only an admin can delete a group');
  }

  log.warn('Resparkable group deleted', { groupId: id });

  return successResponse({ groupId: id, deleted: true });
});
