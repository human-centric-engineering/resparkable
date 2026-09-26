/**
 * GET    /api/v1/resparkable/groups/[id]: the group, and who is in it.
 * PATCH  /api/v1/resparkable/groups/[id]: name, description, member cap, succession.
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
 * naming the group, plus a notification to every other member. Both are checked
 * and sent by `services/group-deletion.ts`, so they hold for every caller and
 * not only for the dialog. The body is `{ confirmName }`; a mismatch is a 400.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { findAccountNames, listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import { deleteGroupConfirmed } from '@/lib/framework/resparkable/services/group-deletion';
import { getLatestGroupDigest } from '@/lib/framework/resparkable/services/group-digest';
import {
  permissionsFor,
  resolveGroupMembership,
  updateGroupSettings,
  visibleMemberRows,
} from '@/lib/framework/resparkable/services/membership';
import { deleteGroupSchema, updateGroupSchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const resolved = await resolveGroupMembership(session.user.id, id);
  if (!resolved) throw new NotFoundError('Group not found');

  const [members, latestDigest] = await Promise.all([
    listGroupMembers(id),
    getLatestGroupDigest(resolved.scope),
  ]);
  const visible = visibleMemberRows(members, resolved.scope.role);

  // The account name of each person asking to join, so the admin deciding
  // whether to let them in can tell who they are. Only requests, and only for
  // an admin (they are the only ones `visibleMemberRows` shows requests to).
  // The name and never the address (decided 2026-09-25).
  const requesterNames = await findAccountNames(
    visible.filter((member) => member.joinedAt === null).map((member) => member.userId)
  );

  log.info('Resparkable group read', { groupId: id, members: members.length });

  return successResponse({
    group: {
      groupId: resolved.membership.groupId,
      name: resolved.membership.group.name,
      slug: resolved.membership.group.slug,
      description: resolved.membership.group.description,
      spaceId: resolved.membership.group.spaceId,
      maxMembers: resolved.membership.group.maxMembers,
      viewersCanInheritAdmin: resolved.membership.group.viewersCanInheritAdmin,
      // When a join link last turned somebody away because the group was full.
      // Admins only: it is how they are told (§23.11), and to anybody else it
      // is a fact about the group's administration they cannot act on.
      joinRefusedFullAt: permissionsFor(resolved.scope.role).administer
        ? resolved.membership.group.joinRefusedFullAt
        : null,
    },
    yourRole: resolved.membership.role,
    // Members by user id and role, and no addresses. Every member can see who
    // else is in the group, which §23.4 makes unavoidable and correct; handing
    // out everybody's email address is a separate decision nobody made. The
    // client resolves display names through the platform's own user surface.
    // Requests to join go to admins only: see `visibleMemberRows`.
    members: visible.map((member) => ({
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
      requestedAt: member.requestedAt,
      name: member.joinedAt === null ? (requesterNames.get(member.userId) ?? null) : null,
    })),
    // The group's newest weekly digest (§23.8), read by every member. It names
    // nobody and ranks nobody: see `services/group-digest.ts`.
    latestDigest,
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

  const body = await validateRequestBody(request, deleteGroupSchema);

  const result = await deleteGroupConfirmed(session.user.id, id, body.confirmName);
  if (!result.ok) {
    if (result.reason === 'not_a_member') throw new NotFoundError('Group not found');
    if (result.reason === 'confirmation_mismatch') {
      throw new ValidationError('Type the group’s name exactly to delete it', {
        confirmName: ['Does not match the group’s name'],
      });
    }
    throw new ForbiddenError('Only an admin can delete a group');
  }

  log.warn('Resparkable group deleted', { groupId: id, notified: result.notified });

  return successResponse({
    groupId: id,
    deleted: true,
    notified: result.notified,
    notifyFailed: result.notifyFailed,
  });
});
