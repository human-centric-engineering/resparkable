/**
 * Membership: the only place a group scope is minted, and the only place
 * membership is read on a request path.
 *
 * ## Why one file, and why it has to stay one file
 *
 * D5 says every brain query is either a space query or a shared query, and there
 * is no third kind. A group workspace is the thing that could most easily add a
 * third: forty list endpoints, each one membership join away from becoming a
 * per-row ACL, `priorityScore`'s single indexed `ORDER BY` defeated, and every
 * one of them a potential leak (§23.4). The rule that prevents it is not a
 * convention about queries, it is a claim about **where** membership is read:
 * once, here, before any content query exists.
 *
 * Two things keep that claim honest, and neither is this comment:
 *
 *   • `rg 'spaceScope\(|spaceScopeFor\('` is the complete list of trust
 *     boundaries in the brain, and it should stay short enough to read. This
 *     file adds the group entries to it.
 *   • `repo/isolation.test.ts` sweeps every scoped repo call and asserts that no
 *     Prisma argument's `where` contains `actorUserId` at any depth. That sweep
 *     was written in phase 45 when the field was inert. From phase 46 on it is
 *     the thing standing between a group space and a per-row ACL.
 *
 * ## What a pending membership resolves to
 *
 * Nothing. Not a `viewer` scope, not a scope on an empty space: `null`, and the
 * caller 404s. `joinedAt: null` means a request to join that an admin has not
 * approved (§23.11), and the difference between "waiting" and "in" is the whole
 * point of phase 57's approval flow. Getting this wrong in phase 46, before
 * anything can even create such a row, is how phase 57 inherits a hole.
 *
 * ## Last admin, and the rules that are here rather than in a route
 *
 * A group with one admin is one resignation or one erasure away from a workspace
 * nobody can administer, holding content nobody can export. So: the last admin
 * cannot leave, be demoted or be removed; when the last admin is erased the role
 * transfers to the longest-standing remaining member; and a group whose last
 * member leaves is deleted rather than left as an unreachable space holding rows.
 * §18's circle-ownership rule is the precedent, same shape and same reasoning.
 *
 * They live in the service and not in the routes because there are five routes
 * and one rule, and the one that gets forgotten is always the fifth.
 *
 * @see .context/framework/resparkable/phase-46-plan.md: decisions 4, 6 and 7
 */

import { randomBytes } from 'node:crypto';

import {
  countAdmins,
  createGroupWithSpace,
  deleteGroupSpace,
  deleteMember,
  findGroupById,
  findGroupBySlug,
  findMembership,
  findMembershipBySpace,
  listGroupMembers,
  listMembershipsForActor,
  updateGroup,
  updateMemberRole,
  type GroupMemberWithGroup,
  type GroupUpdateData,
} from '@/lib/framework/resparkable/repo/groups';
import {
  spaceScopeFor,
  type SpaceRole,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import { slugify } from '@/lib/framework/resparkable/services/slug';
import { logger } from '@/lib/logging';

/**
 * The three roles a group has. `owner` is deliberately absent: it means "the
 * sole human who owns this space", and a group space has no such person (§23.2).
 * B12 makes that a database rule; this makes it a type.
 */
export const GROUP_ROLES = ['admin', 'member', 'viewer'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export function isGroupRole(value: string): value is GroupRole {
  return (GROUP_ROLES as readonly string[]).includes(value);
}

/** 16 bytes of hex, the same shape and the same reasoning as a personal space's. */
function generateInboxToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * A group space key is a cuid-shaped random id, and never a user id.
 *
 * Deliberately minted rather than defaulted by the database: `spaceId` on
 * `ResparkableSpace` has no default, because for a personal space it IS the
 * owner's user id. Using `crypto` rather than Prisma's `cuid()` keeps the two
 * origins visibly different, which matters the day somebody has to answer
 * "is this space key a person?" from the value alone.
 */
function generateGroupSpaceId(): string {
  return `spc_${randomBytes(16).toString('hex')}`;
}

/**
 * Turn an actor and a space into a scope, or into nothing.
 *
 * **This is the trust boundary.** Everything downstream of it is an ordinary
 * space query that cannot express a cross-space read; everything upstream of it
 * is a request that has not been trusted yet.
 *
 * Returns `null` for: a space that is not a group space, a person who is not a
 * member, and a member whose row is still pending. The caller turns all three
 * into a 404 rather than a 403, for the reason every read in this tier gives: a
 * 403 confirms the row exists to somebody who guessed an id.
 *
 * @param actorUserId - **Always** from the verified session or
 *   `CapabilityContext.userId`. Never from a request body, a route param or an
 *   LLM-supplied tool argument (§17 risks 6d, 8, 9).
 * @param spaceId - May come from a route param or a request body. It is a
 *   TARGET, never an authority: this function is what decides whether the actor
 *   may use it, which is why the two arguments have opposite provenance rules.
 */
export async function resolveGroupSpaceScope(
  actorUserId: string,
  spaceId: string
): Promise<SpaceScope | null> {
  if (!actorUserId || !spaceId) return null;

  const membership = await findMembershipBySpace(actorUserId, spaceId);
  if (!membership) return null;
  // Pending. See this file's header: a request to join is not a membership.
  if (membership.joinedAt === null) return null;
  if (!isGroupRole(membership.role)) {
    // A role the code does not recognise resolves to nothing rather than to a
    // guess. The alternative is falling back to `viewer`, which sounds safe and
    // is not: a value written by a future migration, or by a hand-edited row,
    // would silently grant read access to a whole brain.
    logger.warn('Resparkable group membership carries an unknown role', {
      groupId: membership.groupId,
      role: membership.role,
    });
    return null;
  }

  return spaceScopeFor({ spaceId, actorUserId, role: membership.role });
}

/**
 * The same resolution, addressed by group id, for the management routes.
 *
 * Returns the membership as well as the scope, because those routes need the
 * role in order to answer "may this person do this", and re-reading it would be
 * a second query on the same row.
 */
export async function resolveGroupMembership(
  actorUserId: string,
  groupId: string
): Promise<{ membership: GroupMemberWithGroup; scope: SpaceScope } | null> {
  if (!actorUserId || !groupId) return null;

  const membership = await findMembership(actorUserId, groupId);
  if (!membership || membership.joinedAt === null) return null;
  if (!isGroupRole(membership.role)) return null;

  return {
    membership,
    scope: spaceScopeFor({
      spaceId: membership.group.spaceId,
      actorUserId,
      role: membership.role,
    }),
  };
}

/** What a caller may do, resolved once from a role rather than re-derived. */
export interface GroupPermissions {
  /** Invite, remove, change roles, configure the space, delete the group. */
  administer: boolean;
  /** Write brain content in the space. A viewer reads and writes nothing. */
  write: boolean;
}

export function permissionsFor(role: SpaceRole): GroupPermissions {
  return {
    administer: role === 'admin' || role === 'owner',
    write: role !== 'viewer',
  };
}

/** Why a membership change was refused. Every one is a 400 the UI can explain. */
export type MembershipRefusal =
  'not_a_member' | 'not_an_admin' | 'no_such_member' | 'last_admin' | 'unknown_role';

export type MembershipResult<T> = { ok: true; value: T } | { ok: false; reason: MembershipRefusal };

/**
 * Create a group, its space and its founding admin membership.
 *
 * The slug is resolved before the write rather than retried after a collision,
 * because `slug` is globally unique here (a group is addressable by name across
 * the deployment) and a collision is therefore between strangers. Two people
 * naming a group the same thing on the same second is a race this loses cleanly:
 * the second write fails on the unique index and the caller retries, which is
 * the same resolution `ensureResparkableSpace` uses and for the same reason.
 */
export async function createGroup(
  founderUserId: string,
  input: { name: string; description?: string | null }
): Promise<GroupMemberWithGroup> {
  const slug = await resolveFreeGroupSlug(input.name);

  const created = await createGroupWithSpace({
    name: input.name,
    slug,
    description: input.description ?? null,
    spaceId: generateGroupSpaceId(),
    founderUserId,
    inboxToken: generateInboxToken(),
  });

  // No group name in the log line. It is a shared object other people can be
  // identified through, and this line outlives the group.
  logger.info('Resparkable group created', {
    groupId: created.groupId,
    spaceId: created.group.spaceId,
  });

  return created;
}

/** First free `name`, `name-2`, `name-3`… , then a random suffix. */
async function resolveFreeGroupSlug(name: string): Promise<string> {
  const base = slugify(name) || 'group';
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await findGroupBySlug(candidate))) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

/** Amend a group's name, description or member cap. Admin only. */
export async function updateGroupSettings(
  actorUserId: string,
  groupId: string,
  data: GroupUpdateData
): Promise<MembershipResult<GroupMemberWithGroup['group']>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  return { ok: true, value: await updateGroup(groupId, data) };
}

/**
 * Change a member's role.
 *
 * Refuses to demote the last admin, which is the same refusal as removing them
 * and is here rather than in the route for the reason the header gives. Note
 * that it does NOT special-case the actor demoting themselves: an admin stepping
 * down is an ordinary role change, and it is only refused when they are the last
 * one, which is exactly the rule.
 */
export async function changeMemberRole(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  role: string
): Promise<MembershipResult<null>> {
  if (!isGroupRole(role)) return { ok: false, reason: 'unknown_role' };

  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  const target = await findMembership(targetUserId, groupId);
  if (!target) return { ok: false, reason: 'no_such_member' };
  if (target.role === role) return { ok: true, value: null };

  if (target.role === 'admin' && (await countAdmins(groupId)) <= 1) {
    return { ok: false, reason: 'last_admin' };
  }

  await updateMemberRole(groupId, targetUserId, role);
  logger.info('Resparkable group member role changed', { groupId, role });
  return { ok: true, value: null };
}

/**
 * Remove a member, or leave voluntarily.
 *
 * One function for both, because they are the same write with different
 * authority: an admin removing somebody else, or anybody removing themselves.
 * Splitting them would leave two places for the last-admin rule to be forgotten
 * in, and the leave path is the one where forgetting it is likeliest.
 *
 * **A group whose last member leaves is deleted**, rather than left as an
 * unreachable space holding rows. That is not tidiness: a group space is outside
 * the personal erasure cascade by design (§23.2), so a memberless one is a brain
 * no route can open, no cascade can remove, and no subject-access request can
 * reach. It has to go here, at the moment it becomes unreachable, because
 * afterwards nothing is left that knows to look.
 */
export async function removeMember(
  actorUserId: string,
  groupId: string,
  targetUserId: string
): Promise<MembershipResult<{ groupDeleted: boolean }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };

  const removingSomebodyElse = targetUserId !== actorUserId;
  if (removingSomebodyElse && !permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  const target = await findMembership(targetUserId, groupId);
  if (!target) return { ok: false, reason: 'no_such_member' };

  const members = await listGroupMembers(groupId);
  const lastMember = members.length <= 1;

  if (!lastMember && target.role === 'admin' && (await countAdmins(groupId)) <= 1) {
    return { ok: false, reason: 'last_admin' };
  }

  if (lastMember) {
    // The last person out. See the docblock: the space goes with them, because
    // nothing afterwards can reach it.
    await deleteGroupSpace(resolved.membership.group.spaceId);
    logger.info('Resparkable group deleted: its last member left', { groupId });
    return { ok: true, value: { groupDeleted: true } };
  }

  await deleteMember(groupId, targetUserId);
  logger.info('Resparkable group member removed', { groupId, byAdmin: removingSomebodyElse });
  return { ok: true, value: { groupDeleted: false } };
}

/**
 * Delete a group and everything in it. Admin only, and unrecoverable.
 *
 * One `DELETE` of the space row: the group, its memberships, its invitations and
 * all 23 satellites cascade from it (see `deleteGroupSpace`). The typed
 * confirmation naming the group and the notification to every member are §23.6's
 * and land in phase 48; this is the service the route behind them calls.
 */
export async function deleteGroup(
  actorUserId: string,
  groupId: string
): Promise<MembershipResult<null>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  await deleteGroupSpace(resolved.membership.group.spaceId);
  logger.info('Resparkable group deleted', { groupId });
  return { ok: true, value: null };
}

/**
 * Hand the admin role to the longest-standing remaining member.
 *
 * Called when the last admin is **erased**, which is the case §23.3 singles out:
 * a refusal is the right answer when somebody chooses to leave and the wrong one
 * when their account is being deleted, because erasure cannot be refused. The
 * precedent is §18's circle rule, which transfers a circle to its longest-standing
 * member "rather than vanishing".
 *
 * Longest-standing is read off `listGroupMembers`, which orders by `joinedAt`.
 * A member invited in March who accepted in June has been in the group since
 * June, which is what "longest-standing" means to the people in it.
 *
 * Returns the promoted user id, or `null` when the group has no remaining
 * members. The caller deletes the group in that case, for `removeMember`'s
 * reason: a memberless group space is unreachable by anything.
 *
 * Phase 48 wires this into the erasure hook. It is here from the start so the
 * rule and its tests exist before the hook that depends on them.
 */
export async function transferAdminAfterErasure(
  groupId: string,
  erasedUserId: string
): Promise<string | null> {
  const remaining = (await listGroupMembers(groupId)).filter(
    (member) => member.userId !== erasedUserId && member.joinedAt !== null
  );
  if (remaining.length === 0) return null;
  if (remaining.some((member) => member.role === 'admin')) return null;

  const successor = remaining[0];
  await updateMemberRole(groupId, successor.userId, 'admin');
  logger.info('Resparkable group admin transferred after erasure', { groupId });
  return successor.userId;
}

/** Every group this person is in, for the switcher and `GET /groups`. */
export async function listGroupsForActor(actorUserId: string): Promise<GroupMemberWithGroup[]> {
  return listMembershipsForActor(actorUserId);
}

/** Read a group without resolving membership. For routes that already have. */
export async function getGroup(groupId: string): ReturnType<typeof findGroupById> {
  return findGroupById(groupId);
}
