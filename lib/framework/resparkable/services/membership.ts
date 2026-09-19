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
 * transfers to the longest-standing remaining member (unless only viewers are
 * left and the group's settings say a viewer may not inherit it, in which case
 * nobody gets it; see `services/succession.ts`); and a group whose last
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
  deleteGroupSpaceIfMemberless,
  deleteMember,
  findGroupById,
  findGroupBySlug,
  findMembership,
  findMembershipBySpace,
  listGroupMembers,
  listGroupsWithoutAdmin,
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
import { planErasureSuccession } from '@/lib/framework/resparkable/services/succession';
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

// The rule itself lives in `services/succession.ts`, pure, so the group page
// can run it too. Re-exported here because this is where its callers live.
export {
  planErasureSuccession,
  type ErasureSuccession,
} from '@/lib/framework/resparkable/services/succession';

/** What `settleGroupsAfterErasure` did, for the erasure log line. */
export interface ErasureSettlement {
  promoted: number;
  deleted: number;
  /** Groups left with only viewers, whose settings say a viewer may not inherit admin. */
  leftWithoutAdmin: number;
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
  const settlement: ErasureSettlement = { promoted: 0, deleted: 0, leftWithoutAdmin: 0 };

  for (const { groupId, spaceId, viewersCanInheritAdmin } of await listJoinedGroupsForErasure(
    erasedUserId,
    tx
  )) {
    const plan = planErasureSuccession(await listGroupMembers(groupId, tx), erasedUserId, {
      viewersCanInheritAdmin,
    });

    if (plan.kind === 'delete') {
      await deleteGroupSpace(spaceId, tx);
      settlement.deleted += 1;
      logger.info('Resparkable group deleted: its last member was erased', { groupId });
    } else if (plan.kind === 'promote') {
      await updateMemberRole(groupId, plan.userId, 'admin', tx);
      settlement.promoted += 1;
      logger.info('Resparkable group admin transferred after erasure', { groupId });
    } else if (plan.kind === 'no_admin') {
      settlement.leftWithoutAdmin += 1;
      logger.info('Resparkable group left without an admin: only viewers remain', { groupId });
    }
  }

  return settlement;
}

/** Groups the stranded-group sweep looks at per pass. Rarely more than zero match. */
const STRANDED_GROUP_BATCH = 50;

/**
 * Repair groups an erasure left without an admin, or without anybody.
 *
 * The backstop for `settleGroupsAfterErasure`. That runs from the erasure hook,
 * and core's hook registry is a plain module-scoped `Map` that may be empty in
 * the realm where erasure runs (Sunrise ask #44). When it is, the erased
 * person's membership still cascades, but nothing promotes a successor or
 * deletes the group they leave empty. This finds those groups afterwards and
 * applies the same rule, `planErasureSuccession`, so the two paths cannot
 * disagree about what should have happened.
 *
 * **Anything this settles is a sign the hook was missing**, which is why it
 * logs at `warn` rather than `info`. Request paths cannot strand a group (see
 * `listGroupsWithoutAdmin`), so a quiet sweep is the expected state.
 *
 * Safe to run on every instance at once. A delete re-checks for joined members
 * in the statement itself, so a group somebody joined in the meantime is kept;
 * a promotion that races another is at worst a second admin, which the group can
 * undo. One group failing is logged and does not stop the rest.
 *
 * Takes no actor for the same reason `settleGroupsAfterErasure` does not: the
 * rule it applies is the one erasure would have applied, and erasure cannot be
 * refused. Its only caller is the job in `jobs.ts`.
 */
export async function settleStrandedGroups(
  limit: number = STRANDED_GROUP_BATCH
): Promise<ErasureSettlement> {
  const settlement: ErasureSettlement = { promoted: 0, deleted: 0, leftWithoutAdmin: 0 };

  for (const { groupId, spaceId, viewersCanInheritAdmin } of await listGroupsWithoutAdmin(limit)) {
    try {
      const plan = planErasureSuccession(await listGroupMembers(groupId), null, {
        viewersCanInheritAdmin,
      });

      if (plan.kind === 'delete') {
        if (await deleteGroupSpaceIfMemberless(groupId, spaceId)) {
          settlement.deleted += 1;
          logger.warn('Resparkable stranded group deleted: it had no members left', { groupId });
        }
      } else if (plan.kind === 'promote') {
        await updateMemberRole(groupId, plan.userId, 'admin');
        settlement.promoted += 1;
        logger.warn('Resparkable stranded group given an admin', { groupId });
      }
      // `unchanged`: an admin appeared between the two reads. `no_admin`: the
      // group chose this, and `listGroupsWithoutAdmin` skips such groups, so
      // reaching it here means the last member left between the two reads.
      // Nothing to do for either, and neither counts as settled.
    } catch (error) {
      logger.error('Resparkable stranded-group repair failed for one group', {
        groupId,
        error: error instanceof Error ? error.message : String(error),
      });
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
