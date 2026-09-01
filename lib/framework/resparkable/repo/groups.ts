/**
 * Group repo: the second exception to the D5 signature rule, and the last one.
 *
 * Every other file in `repo/**` takes a `SpaceScope` first and spreads
 * `spaceWhere(scope)` into its `where`. Two do not. `repo/space.ts` is where a
 * PERSONAL scope comes from, so it takes a verified user id; this file is where
 * a GROUP scope comes from, so it takes a verified user id and a group or space
 * id. A function that answers "may this person open this space" cannot take the
 * answer as an argument.
 *
 * The exception is narrow and has to stay narrow, which is why both files are
 * short enough to audit at a glance. Nothing here reads brain content. The rows
 * in these three tables are the membership relation and nothing else, and the
 * moment one of them is joined to a task list, a group space has the per-row ACL
 * §23.4 forbids: a membership join on the hot path of roughly forty list
 * endpoints, `priorityScore`'s single indexed `ORDER BY` defeated, and every one
 * of those endpoints a potential leak.
 *
 * `repo/isolation.test.ts`'s `SCOPED_CALLS` table does not enumerate this file,
 * for the same reason it does not enumerate `repo/space.ts`: there is no scope
 * to assert on. That table carries a note naming both, because "absent from the
 * sweep" and "forgotten" are otherwise indistinguishable.
 *
 * ## Reads take an actor, and it is never a filter on brain content
 *
 * `actorUserId` appears in a `where` here and only here. That is not a
 * contradiction of `SpaceScope`'s rule, it is the rule's other half: membership
 * resolves ONCE, in this layer, and the resulting scope carries the actor for
 * attribution only. `isolation.test.ts` asserts no scoped query mentions it.
 *
 * @see lib/framework/resparkable/services/membership.ts: the only caller that
 *      turns these rows into a scope
 * @see .context/framework/resparkable/phase-46-plan.md: decisions 4 and 5
 */

import { prisma } from '@/lib/db/client';
import type {
  Prisma,
  ResparkableGroup,
  ResparkableGroupInvite,
  ResparkableGroupMember,
} from '@prisma/client';

/** A membership row with the group it belongs to, which every caller needs. */
export type GroupMemberWithGroup = ResparkableGroupMember & { group: ResparkableGroup };

/** What a group is created with. The space is minted by the same transaction. */
export interface GroupCreateData {
  name: string;
  slug: string;
  description: string | null;
  /** The group's own space key: a cuid, never a user id. */
  spaceId: string;
  /** The founder, who is always an admin. A group with no admin cannot exist. */
  founderUserId: string;
  /** Everything `createSpace` needs that is not derivable here. */
  inboxToken: string;
}

/** The fields a PATCH may move. `slug` and `spaceId` are deliberately absent. */
export interface GroupUpdateData {
  name?: string;
  description?: string | null;
  maxMembers?: number;
}

/**
 * Create a group, its space and its founding admin membership, atomically.
 *
 * ## Why the space is written here and not by `ensureResparkableSpace`
 *
 * That function mints a PERSONAL space: it keys the row on a user id, sets
 * `ownerUserId` to the same value, and seeds jobs and a credit account. A group
 * space is the opposite on every one of those points. Parameterising one
 * function to produce both is how a group space ends up with an `ownerUserId`,
 * which the B12 CHECK then rejects at 500 on somebody's first group, and which
 * would otherwise mean one member closing their account destroys a shared
 * workspace (§23.2).
 *
 * `ownerUserId: null` is therefore explicit rather than defaulted, in the one
 * place a group space comes into existence, so a reader can see what one is
 * without going to the schema for the answer.
 *
 * **No jobs and no credit account.** A group space has no scheduled work and no
 * balance until phase 50 gives it a budget (§23.12), and that is the safe state
 * to ship in: nothing bills anybody for a workspace nobody has funded. The
 * absence is deliberate and is why this function does not call
 * `ensureResparkableJobs`.
 *
 * All three writes are one transaction. A group whose space failed to write is
 * a row pointing at nothing; a space whose group failed to write is an orphan
 * brain no cascade reaches, because a group space is deliberately outside the
 * personal one.
 */
export async function createGroupWithSpace(
  data: GroupCreateData,
  now: Date = new Date()
): Promise<GroupMemberWithGroup> {
  return prisma.$transaction(async (tx) => {
    await tx.resparkableSpace.create({
      data: {
        spaceId: data.spaceId,
        kind: 'group',
        // See this function's docblock. Never a user id, on any path.
        ownerUserId: null,
        // A group space is never anybody's default capture target. §24.2's
        // partial unique index only constrains rows with an owner, so this is a
        // product rule rather than a constraint, and it is the rule §23.4's
        // "capture always names its target, and the default is always personal"
        // depends on.
        isDefault: false,
        name: data.name,
        slug: data.slug,
        inboxToken: data.inboxToken,
      },
    });

    const group = await tx.resparkableGroup.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description,
        spaceId: data.spaceId,
      },
    });

    return tx.resparkableGroupMember.create({
      data: {
        groupId: group.id,
        userId: data.founderUserId,
        // The founder is an admin because a group with no admin is a workspace
        // nobody can administer, holding content nobody can export. The
        // last-admin rules in `services/membership.ts` are what keep that true
        // afterwards.
        role: 'admin',
        joinedAt: now,
      },
      include: { group: true },
    });
  });
}

/**
 * The membership read every group request path makes: one indexed lookup.
 *
 * Keyed on `@@unique([groupId, userId])` through the space rather than the group
 * id, because callers hold a space id (it is in the URL) and not a group id.
 * That is one extra hop in the index and no extra query: the group's `spaceId`
 * index resolves it.
 *
 * Returns the row whether or not it is live. Deciding what a pending membership
 * means is the service's job, not this layer's, and `joinedAt: null` (§23.11) is
 * a state the resolver has to be able to see in order to refuse it.
 */
export async function findMembershipBySpace(
  actorUserId: string,
  spaceId: string
): Promise<GroupMemberWithGroup | null> {
  return prisma.resparkableGroupMember.findFirst({
    where: { userId: actorUserId, group: { spaceId } },
    include: { group: true },
  });
}

/** The same read, addressed by group id, for the group-management routes. */
export async function findMembership(
  actorUserId: string,
  groupId: string
): Promise<GroupMemberWithGroup | null> {
  return prisma.resparkableGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId: actorUserId } },
    include: { group: true },
  });
}

/**
 * Every group this person belongs to, for the switcher and `GET /groups`.
 *
 * Pending memberships included, and labelled by their own `joinedAt`. A person
 * waiting on an admin should see that they are waiting; hiding the row makes the
 * request look like it was never sent.
 */
export async function listMembershipsForActor(
  actorUserId: string
): Promise<GroupMemberWithGroup[]> {
  return prisma.resparkableGroupMember.findMany({
    where: { userId: actorUserId },
    include: { group: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Everyone in a group, oldest first.
 *
 * Oldest first is not cosmetic here: the last-admin succession rule promotes the
 * longest-standing remaining member (§23.3), so this order IS the succession
 * order and the service reads it rather than sorting again. `joinedAt` is the
 * key rather than `createdAt`, because a member invited in March who accepted in
 * June has been in the group since June.
 */
export async function listGroupMembers(groupId: string): Promise<ResparkableGroupMember[]> {
  return prisma.resparkableGroupMember.findMany({
    where: { groupId },
    orderBy: [{ joinedAt: 'asc' }, { createdAt: 'asc' }],
  });
}

/** How many admins a group has. The number every last-admin rule turns on. */
export async function countAdmins(groupId: string): Promise<number> {
  return prisma.resparkableGroupMember.count({
    where: { groupId, role: 'admin', joinedAt: { not: null } },
  });
}

export async function findGroupById(groupId: string): Promise<ResparkableGroup | null> {
  return prisma.resparkableGroup.findUnique({ where: { id: groupId } });
}

export async function findGroupBySlug(slug: string): Promise<ResparkableGroup | null> {
  return prisma.resparkableGroup.findUnique({ where: { slug } });
}

export async function updateGroup(
  groupId: string,
  data: GroupUpdateData
): Promise<ResparkableGroup> {
  return prisma.resparkableGroup.update({ where: { id: groupId }, data });
}

export async function updateMemberRole(
  groupId: string,
  userId: string,
  role: string
): Promise<ResparkableGroupMember> {
  return prisma.resparkableGroupMember.update({
    where: { groupId_userId: { groupId, userId } },
    data: { role },
  });
}

/**
 * Add a member. Used by the invite-acceptance path and by nothing else.
 *
 * An upsert rather than a create: re-accepting an invitation for a group you are
 * already in must not be a 500, and `@@unique([groupId, userId])` would make it
 * one. The update deliberately does NOT move `role`, so accepting a stale
 * invitation cannot quietly demote an admin.
 */
export async function upsertMember(data: {
  groupId: string;
  userId: string;
  role: string;
  invitedByUserId: string | null;
  joinedAt: Date;
}): Promise<ResparkableGroupMember> {
  return prisma.resparkableGroupMember.upsert({
    where: { groupId_userId: { groupId: data.groupId, userId: data.userId } },
    create: data,
    update: { joinedAt: data.joinedAt },
  });
}

export async function deleteMember(groupId: string, userId: string): Promise<void> {
  await prisma.resparkableGroupMember.delete({
    where: { groupId_userId: { groupId, userId } },
  });
}

/**
 * Delete a group by deleting the space it owns.
 *
 * **This is the whole deletion path and it is one statement.** The group row
 * cascades from `framework_resparkable_space`, and every satellite cascades from
 * the same row, so removing the space removes the brain, the group, its
 * memberships and its outstanding invitations in one go, in the order Postgres
 * works out. Deleting the group row instead would leave the space and all 23
 * satellites behind as an orphan brain no cascade can reach, because a group
 * space has `ownerUserId IS NULL` and is deliberately outside the personal
 * cascade (§23.2, probe B12).
 *
 * Unrecoverable, and affects people who are not the actor. The typed
 * confirmation and the notification to every member are the caller's
 * responsibility (§23.6, phase 48).
 */
export async function deleteGroupSpace(spaceId: string): Promise<void> {
  await prisma.resparkableSpace.delete({ where: { spaceId } });
}

/** Outstanding invitations for a group, newest first, for the admin's list. */
export async function listGroupInvites(groupId: string): Promise<ResparkableGroupInvite[]> {
  return prisma.resparkableGroupInvite.findMany({
    where: { groupId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Issue or re-issue an invitation to one address.
 *
 * An upsert, for the reason `upsertGrant` is one: re-inviting somebody is
 * amending the invitation, not adding a second beside it, and
 * `@@unique([groupId, email])` makes the alternative a 409 the UI would have to
 * explain.
 *
 * **Re-issuing clears `acceptedAt` as well as `revokedAt`**, and the first
 * version of this deliberately did not, on the reasoning that a spent invitation
 * must not become live again. That reasoning was right about the invitation and
 * wrong about the row: the row is the deployment's single record of "this
 * address, this group", so leaving `acceptedAt` set meant somebody who had
 * joined, left, and been invited back could never accept, and the failure
 * surfaced as an unexplained "this invitation is not available".
 *
 * The invariant it was protecting is held by the token instead, and held better:
 * the update overwrites `inviteTokenHash`, so the previously spent token now
 * resolves to no row at all. An old link cannot be replayed; a new one works.
 */
export async function upsertInvite(data: {
  groupId: string;
  email: string;
  role: string;
  invitedByUserId: string;
  inviteTokenHash: string;
  expiresAt: Date | null;
}): Promise<ResparkableGroupInvite> {
  const { groupId, email, ...rest } = data;
  return prisma.resparkableGroupInvite.upsert({
    where: { groupId_email: { groupId, email } },
    create: { groupId, email, ...rest },
    // `rest` carries the fresh `inviteTokenHash`, which is what makes clearing
    // both timestamps safe. See the docblock.
    update: { ...rest, revokedAt: null, acceptedAt: null },
  });
}

/**
 * Resolve an invitation by its token digest.
 *
 * Takes a hash, never a token: hashing happens at the boundary so that a raw
 * token never reaches a query the database logs. The same discipline
 * `findGrantByInviteTokenHash` follows.
 */
export async function findInviteByTokenHash(
  inviteTokenHash: string
): Promise<(ResparkableGroupInvite & { group: ResparkableGroup }) | null> {
  return prisma.resparkableGroupInvite.findUnique({
    where: { inviteTokenHash },
    include: { group: true },
  });
}

/**
 * Mark an invitation spent, and refuse to do it twice.
 *
 * `acceptedAt: null` in the `where` is the load-bearing clause: it makes
 * acceptance a compare-and-set, so two requests racing on the same token produce
 * one acceptance and one miss rather than two. The miss reads as an unknown
 * token, which is the correct answer to a spent one.
 */
export async function markInviteAccepted(inviteId: string, now: Date): Promise<{ count: number }> {
  return prisma.resparkableGroupInvite.updateMany({
    where: { id: inviteId, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: now },
  });
}

export async function revokeInvite(
  groupId: string,
  inviteId: string,
  now: Date
): Promise<{ count: number }> {
  return prisma.resparkableGroupInvite.updateMany({
    where: { id: inviteId, groupId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/** What acceptance did, so the caller does not have to infer it from clocks. */
export interface AcceptOutcome {
  member: ResparkableGroupMember;
  /**
   * False when the person was already a joined member of this group.
   *
   * Reported rather than derived. The first version of this compared the row's
   * `createdAt` against a timestamp taken in the application, which works only
   * as long as the database clock trails the application's by less than the
   * request takes: under the opposite skew somebody who had just joined was told
   * they were already a member.
   */
  joinedNow: boolean;
}

/**
 * Accept an invitation: mark it spent and create the membership, atomically.
 *
 * The two writes are one transaction because the failure between them is silent
 * in both directions. A spent invitation with no membership is a person who
 * clicked a working link and got nothing, with no way to try again; a membership
 * from an invitation still marked live is an invitation that can be spent twice.
 *
 * Returns `null` when the compare-and-set loses, which the caller reports as an
 * unknown token rather than as a race, for the reason every failure on this path
 * gives one answer: anything distinguishable turns the accept page into an
 * oracle about which invitations once existed.
 *
 * ## The three states of the membership row, and why this is not an upsert
 *
 * An upsert has two branches and there are three cases, which is exactly how the
 * third one got lost:
 *
 *   • **No row.** Create it, joined now.
 *   • **A joined row.** Somebody already in, on a second invitation. Nothing
 *     moves, because accepting a stale link must not change a role: an admin
 *     would be quietly demoted to whatever the invitation said.
 *   • **A PENDING row** (`joinedAt: null`), which is §23.11's request-to-join
 *     waiting on an admin. `update: {}` left it pending, so the invitation was
 *     marked spent, the caller was told they had joined, and the person still
 *     resolved to no scope at all with no second invitation issuable. Admitting
 *     them is the whole point of an invitation, so `joinedAt` is stamped.
 *
 * Phase 46 creates no pending rows, so today only the first two arise. Phase 57
 * creates them, and the design note for this branch said the resolver should be
 * written so that phase adds a predicate rather than a branch. The same applies
 * here: it is a bug now and an exploitable one later.
 */
export async function acceptInviteAndJoin(
  invite: { id: string; groupId: string; role: string; invitedByUserId: string | null },
  userId: string,
  now: Date
): Promise<AcceptOutcome | null> {
  return prisma.$transaction(async (tx) => {
    const spent = await tx.resparkableGroupInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (spent.count === 0) return null;

    const existing = await tx.resparkableGroupMember.findUnique({
      where: { groupId_userId: { groupId: invite.groupId, userId } },
    });

    if (!existing) {
      return {
        member: await tx.resparkableGroupMember.create({
          data: {
            groupId: invite.groupId,
            userId,
            role: invite.role,
            invitedByUserId: invite.invitedByUserId,
            joinedAt: now,
          },
        }),
        joinedNow: true,
      };
    }

    if (existing.joinedAt === null) {
      // Pending, and this invitation is what admits them. `role` still does not
      // move: the pending row carries whatever role the request-to-join was
      // filed under, and an invitation is not the place to change it.
      return {
        member: await tx.resparkableGroupMember.update({
          where: { groupId_userId: { groupId: invite.groupId, userId } },
          data: { joinedAt: now },
        }),
        joinedNow: true,
      };
    }

    return { member: existing, joinedNow: false };
  });
}

/** Narrow the transaction client's type without importing the runtime namespace. */
export type GroupTx = Prisma.TransactionClient;
