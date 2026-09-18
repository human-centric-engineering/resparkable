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
  listJoinedGroupsForErasure,
  listMembershipsForActor,
  updateGroup,
  updateMemberRole,
  type GroupMemberWithGroup,
  type GroupTx,
  type GroupUpdateData,
} from '@/lib/framework/resparkable/repo/groups';
import {
  spaceScope,
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
 * Turn a request's space target into a scope. The entry point for every HTTP
 * path in the tier, and the reason a route no longer mints its own.
 *
 * **Absence is the personal space, and so is the actor's own space id.** Two
 * spellings of one answer, because the second is unavoidable: a personal
 * space's key IS its owner's user id (phase 45 kept that identity), so a link
 * built from the switcher while sitting in a personal space carries it. Both
 * resolve through `spaceScope()`, which is the same scope the tier has minted
 * since Release 1, so this function changes nothing for a user who is in no
 * group.
 *
 * **Anything else is a group space, and membership decides.** A non-member, a
 * pending member and a space that does not exist are one answer here: `null`,
 * which the caller turns into a 404. That is `resolveGroupSpaceScope`'s
 * contract and this function adds nothing to it.
 *
 * ## What this is not for
 *
 * Capture. Every capture path takes its target from an explicit field and
 * defaults to personal, and none of them reads the ambient space off the URL,
 * because "the last space was sticky" is precisely the failure §23.4 names
 * (phase 47's own acceptance criterion, test 13e). Reading here is for a
 * surface that is *displaying* a workspace, where the URL is the question the
 * user asked.
 *
 * @param actorUserId - **Always** from the verified session.
 * @param spaceTarget - From `readSpaceTarget()`, and untrusted. See
 *   `ui/active-space.ts` for why a target and a scope are different words.
 */
export async function resolveActiveSpaceScope(
  actorUserId: string,
  spaceTarget: string | null
): Promise<SpaceScope | null> {
  if (!actorUserId) return null;
  if (!spaceTarget || spaceTarget === actorUserId) return spaceScope(actorUserId);

  return resolveGroupSpaceScope(actorUserId, spaceTarget);
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

  // Joined members only, matching `countAdmins`, which excludes pending rows on
  // purpose. Counting them here and not there was an inconsistency with a real
  // consequence: a sole admin sitting beside one request-to-join failed the
  // "last member out" short-circuit, fell through to the last-admin rule, and
  // could never leave their own group. A pending row is somebody asking to come
  // in, and it cannot be the reason somebody else is trapped.
  const members = (await listGroupMembers(groupId)).filter((member) => member.joinedAt !== null);
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

/** What erasing one member means for one group. */
export type ErasureSuccession =
  { kind: 'unchanged' } | { kind: 'promote'; userId: string } | { kind: 'delete' };

/**
 * Decide what erasing a member does to a group. Pure, so the rule can be read
 * and tested without a transaction.
 *
 * Three answers, and the first version of this conflated two of them: it
 * returned `null` both for "another admin is still here" and for "nobody is left",
 * and left the caller to tell them apart by reading the members a second time.
 *
 *   • **Nobody joined is left: delete.** `removeMember`'s reason: a memberless
 *     group space is a brain no route can open, no cascade can remove and no
 *     subject-access request can reach. Pending rows do not count, because a
 *     request to join cannot keep a workspace alive.
 *   • **The erased member was the last admin: promote** the longest-standing
 *     remaining member (§23.3). Erasure cannot be refused, which is what makes
 *     this different from leaving, where the same situation is a `last_admin`
 *     refusal. The precedent is §18's circle rule.
 *   • **Otherwise nothing.** Their membership row cascades with the user, and
 *     the group carries on without them.
 *
 * Longest-standing is `members`' own order, which `listGroupMembers` sorts by
 * `joinedAt`: a member invited in March who accepted in June has been in the
 * group since June. A pending member is never promoted, because that would make
 * erasure a way past the approval queue.
 */
export function planErasureSuccession(
  members: ReadonlyArray<{ userId: string; role: string; joinedAt: Date | null }>,
  erasedUserId: string
): ErasureSuccession {
  const remaining = members.filter(
    (member) => member.userId !== erasedUserId && member.joinedAt !== null
  );
  if (remaining.length === 0) return { kind: 'delete' };
  if (remaining.some((member) => member.role === 'admin')) return { kind: 'unchanged' };
  return { kind: 'promote', userId: remaining[0].userId };
}

/** What `settleGroupsAfterErasure` did, for the erasure log line. */
export interface ErasureSettlement {
  promoted: number;
  deleted: number;
}

/**
 * Apply `planErasureSuccession` to every group the erased person had joined.
 *
 * Runs inside `eraseUser`'s transaction, through `tx`, so it commits or rolls
 * back with the erasure itself. Written through the global client, a promotion
 * would survive an erasure that failed, and the group would have two admins
 * where it meant to have one.
 *
 * **It takes no actor and performs no authorization**, deliberately: erasure
 * cannot be refused, so there is no principal to check. That makes it unsafe
 * to call from anywhere else. It promotes a member to admin and deletes whole
 * workspaces from a bare user id, and the only caller it may ever have is the
 * erasure hook in `privacy/erasure.ts`.
 *
 * What it does NOT do is remove the erased person's own membership rows, null
 * `createdByUserId` on what they wrote, or touch a group space that still has
 * people in it. Those are database constraints (B13, B11 and B12), and doing
 * any of them here would be a second definition of what erasure means.
 *
 * @internal Erasure-hook use only. Never call this from a request path.
 */
export async function settleGroupsAfterErasure(
  erasedUserId: string,
  tx: GroupTx
): Promise<ErasureSettlement> {
  const settlement: ErasureSettlement = { promoted: 0, deleted: 0 };

  for (const { groupId, spaceId } of await listJoinedGroupsForErasure(erasedUserId, tx)) {
    const plan = planErasureSuccession(await listGroupMembers(groupId, tx), erasedUserId);

    if (plan.kind === 'delete') {
      await deleteGroupSpace(spaceId, tx);
      settlement.deleted += 1;
      logger.info('Resparkable group deleted: its last member was erased', { groupId });
    } else if (plan.kind === 'promote') {
      await updateMemberRole(groupId, plan.userId, 'admin', tx);
      settlement.promoted += 1;
      logger.info('Resparkable group admin transferred after erasure', { groupId });
    }
  }

  return settlement;
}

/** Every group this person is in, for the switcher and `GET /groups`. */
export async function listGroupsForActor(actorUserId: string): Promise<GroupMemberWithGroup[]> {
  return listMembershipsForActor(actorUserId);
}

/** Read a group without resolving membership. For routes that already have. */
export async function getGroup(groupId: string): ReturnType<typeof findGroupById> {
  return findGroupById(groupId);
}
