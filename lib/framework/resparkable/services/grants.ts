/**
 * Named grants — the owner's side of "share this with a person".
 *
 * The sibling of `services/sharing.ts`, which owns the other kind of share.
 * The product line between them is the one §13 draws and this whole layer is
 * arranged around: **a public link is a document, a named grant is a
 * relationship.** A stranger holding a URL gets the content and nothing about
 * the person; someone the owner named gets to know who shared it, and (with
 * `role: 'commenter'`, phase 13) to say something back.
 *
 * Three things live here rather than in a route.
 *
 * ## 1. The account lookup, and what must never be done with its answer
 *
 * A grant is addressed to an **email**, not to an account. If that address
 * already has one, `granteeUserId` is filled in at once so the grant works on
 * the grantee's very next request rather than waiting for an acceptance they
 * may never perform — `granteeClauses` in `access/store.ts` matches on the
 * address as well, so the access is live either way, but the id is what
 * survives the person changing their address later.
 *
 * **The response must not say which happened.** §13 is explicit: identical
 * shape whether or not the account exists. A 201 that differed — a field, a
 * status word, even a different latency profile worth measuring — would turn
 * "share with someone" into an account-existence oracle that anybody with a
 * signup form could query one address at a time. So {@link GrantSummary} has no
 * `granteeUserId` and no `hasAccount`, and `accepted` is driven by `acceptedAt`,
 * which only a real acceptance sets.
 *
 * ## 2. Ownership is checked before the grant is written, not after
 *
 * `ownsEntity` is the same guard the mint path uses, and for the same reason: a
 * grant issued against a row the caller does not own would be a live grant
 * pointing at nothing, addressed to a real person who would see a 404 they
 * could not explain.
 *
 * ## 3. Reading a granted item is NOT here
 *
 * That is a shared query — the caller is not the owner — and it lives in
 * `services/shared-with-me.ts`. Everything in this file takes an `SpaceScope`
 * and answers a question about the owner's own brain.
 */

import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  findAccountIdForEmail,
  findOwnGrant,
  listOwnGrants as listOwnGrantRows,
  revokeGrant as revokeGrantRow,
  updateGrant as updateGrantRow,
  upsertGrant,
  type GrantFilters,
  type GrantGrantee,
} from '@/lib/framework/resparkable/repo/grants';
import {
  findGroupLabelsBySpaceIds,
  type GroupLabel,
} from '@/lib/framework/resparkable/repo/groups';
import { ownsEntity } from '@/lib/framework/resparkable/repo/share-links';
import {
  listGroupsForActor,
  isGroupRole,
  permissionsFor,
  resolveGroupSpaceScope,
} from '@/lib/framework/resparkable/services/membership';
import type { CreateGrantInput, UpdateGrantInput } from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import { isShareActive } from '@/lib/utils/share-window';
import type { ResparkableGrant } from '@prisma/client';

/**
 * The default and maximum expiry for a named grant.
 *
 * Ninety days rather than the link surface's thirty. The two are deliberately
 * different numbers: a link is usually issued for one conversation and should
 * stop working after it, whereas a grant is issued to a colleague for the
 * duration of a piece of work, and a quarter is roughly how long that is. The
 * ceiling is the same year, for the same reason — a standing credential to
 * another person's thinking that outlives the reason it was issued is the shape
 * of the problem, whichever surface it arrived on.
 */
export const GRANT_DEFAULT_DAYS = 90;
export const GRANT_MAX_DAYS = 365;

function resolveExpiry(expiry: CreateGrantInput['expiry'], now: Date): Date | null {
  if (expiry.kind === 'never') return null;
  return new Date(now.getTime() + expiry.days * 24 * 60 * 60 * 1000);
}

/**
 * A grant as the **owner** sees it.
 *
 * `granteeEmail` is present because the owner typed it: it is their own record
 * of who they shared with, and masking it here would make the list unusable for
 * the one person entitled to read it. `granteeUserId` is absent for the reason
 * in this file's header, and `inviteTokenHash` is absent because a digest in a
 * response is a digest in a browser's memory, a client store and a screenshot.
 */
export interface GrantSummary {
  id: string;
  entityType: string;
  entityId: string;
  /** The person the grant is to. Null for a grant to a group. */
  granteeEmail: string | null;
  /**
   * The group the grant is to, named for the owner with its current joined
   * member count (§23.7): who can read this is "everyone in Study Group B, 14
   * people today", and a roll that changes is the reason the count is shown.
   * Null for a grant to a person, and for a group deleted since (whose grants
   * cascaded, so that row cannot be listed anyway).
   *
   * `memberCount` is null unless the reader is a joined member of that group.
   * The name is the grantor's own record of where the item went, and every
   * member of the grantor workspace needs it to manage the grant. The count is
   * the grantee group's business: it moves as people join and leave, so showing
   * it to outsiders would let them watch another group's roll.
   */
  granteeGroup: { spaceId: string; name: string; memberCount: number | null } | null;
  role: string;
  includeTaskDetail: boolean;
  /**
   * Whether the grantee has bound an account to this grant.
   *
   * **Not the same question as "can they see it yet"** — they can, from the
   * moment it is issued, because the address matches. This says whether they
   * have been through the invite flow, which is what lets the owner tell a
   * grant somebody has engaged with from one still sitting in a mailbox.
   */
  accepted: boolean;
  invitedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
  createdAt: Date;
}

/**
 * Summarise grants for their owner, naming group grantees in one query.
 *
 * Batched because the owner's list may hold many grants to a handful of groups,
 * and asking per row is the N+1 `CLAUDE.md` forbids on list endpoints. The
 * reader's memberships are one more query, and only when a group grant is on
 * the list: they decide which member counts the reader may see.
 */
export async function toGrantSummaries(
  scope: SpaceScope,
  grants: readonly ResparkableGrant[],
  now: Date = new Date()
): Promise<GrantSummary[]> {
  const groupSpaceIds = grants
    .map((grant) => grant.granteeSpaceId)
    .filter((id): id is string => id !== null);
  const [labels, joined] = await Promise.all([
    findGroupLabelsBySpaceIds(groupSpaceIds),
    joinedGroupSpaceIds(scope, groupSpaceIds.length > 0),
  ]);

  return grants.map((grant) => {
    const label = grant.granteeSpaceId ? labels.get(grant.granteeSpaceId) : undefined;
    return toGrantSummary(
      grant,
      label
        ? {
            spaceId: label.spaceId,
            name: label.name,
            memberCount: joined.has(label.spaceId) ? label.memberCount : null,
          }
        : null,
      now
    );
  });
}

/** The group spaces the reader has joined, in any role. Empty when not needed. */
async function joinedGroupSpaceIds(scope: SpaceScope, needed: boolean): Promise<Set<string>> {
  if (!needed || !scope.actorUserId) return new Set();
  const memberships = await listGroupsForActor(scope.actorUserId);
  return new Set(
    memberships
      .filter((membership) => membership.joinedAt !== null)
      .map((membership) => membership.group.spaceId)
  );
}

function toGrantSummary(
  grant: ResparkableGrant,
  granteeGroup: GrantSummary['granteeGroup'],
  now: Date
): GrantSummary {
  return {
    id: grant.id,
    entityType: grant.entityType,
    entityId: grant.entityId,
    granteeEmail: grant.granteeEmail,
    granteeGroup,
    role: grant.role,
    includeTaskDetail: grant.includeTaskDetail,
    accepted: grant.acceptedAt !== null,
    invitedAt: grant.inviteSentAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    active: isShareActive(grant, now),
    createdAt: grant.createdAt,
  };
}

/**
 * Issue a grant, or amend the one already addressed to that person.
 *
 * Returns `null` when the item is not the owner's or does not exist — the same
 * answer the mint path gives, and the same 404 at the route, because a 403
 * would confirm the row exists to someone who guessed an id.
 *
 * Sending the invite email is **not** done here. It is phase 13, and keeping it
 * out means the grant is a database fact before it is a message: an email that
 * fails to send leaves a working grant rather than a person who was told they
 * had access and does not.
 */
export async function issueGrant(
  scope: SpaceScope,
  input: CreateGrantInput,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  if (!permissionsFor(scope.role).write) return null;
  if (!(await ownsEntity(scope, input.entityType, input.entityId))) return null;

  const grantee = await resolveGrantee(scope, input.grantee);
  if (!grantee) return null;

  const grant = await upsertGrant(scope, {
    entityType: input.entityType,
    entityId: input.entityId,
    grantee,
    role: input.role,
    includeTaskDetail: input.includeTaskDetail,
    expiresAt: resolveExpiry(input.expiry, now),
  });

  // No address, and no `hasAccount`. The log is read by operators who are not
  // the owner, and a grantee's email in it is one person's contact details
  // sitting in another person's infrastructure for the life of the log.
  logger.info('Resparkable grant issued', {
    entityType: grant.entityType,
    granteeKind: grantee.kind,
    role: grant.role,
    includeTaskDetail: grant.includeTaskDetail,
    expires: grant.expiresAt !== null,
  });

  const [summary] = await toGrantSummaries(scope, [grant], now);
  return summary;
}

/**
 * Turn the requested grantee into one this grant may be written to.
 *
 * **A group must be one the caller is a joined member of.** That is the whole
 * of the discovery rule for phase 49: §23.11 declined a public directory of
 * groups, and a grant form that accepted any group's id would be one, answering "does a group with this id exist?" by whether the
 * share went through. The answer for a group the caller is not in is the same
 * `null` as for an item they do not own, so the route gives the same 404.
 *
 * **And a role in it that can write.** A group viewer is not offered the group
 * and cannot name it: sharing into a group puts an item in front of everyone in
 * it, which is a write in that workspace.
 *
 * A group cannot be the grantee of its own item. That is a request-shape
 * mistake rather than an access question, so the route refuses it with a 400
 * before this runs, and this refuses it again rather than trusting that.
 */
async function resolveGrantee(
  scope: SpaceScope,
  grantee: CreateGrantInput['grantee']
): Promise<GrantGrantee | null> {
  if (grantee.kind === 'person') {
    return {
      kind: 'person',
      email: grantee.email,
      userId: await findAccountIdForEmail(grantee.email),
    };
  }

  if (grantee.spaceId === scope.spaceId) return null;
  // A viewer in the target group cannot share into it: adding an item to the
  // group's shared list is a write in the group's workspace, and a group viewer
  // writes nothing (§23.3). Same `null`, so the same 404.
  if (!(await canShareIntoSpace(scope, grantee.spaceId))) return null;
  return { kind: 'group', spaceId: grantee.spaceId };
}

/**
 * Whether the actor behind this scope may put an item in front of that group
 * today: a joined member, in a role that can write. Issuing and amending a
 * group grant both ask it, so neither can be reached without the other's rule.
 */
async function canShareIntoSpace(scope: SpaceScope, groupSpaceId: string): Promise<boolean> {
  if (!scope.actorUserId) return false;
  const membership = await resolveGroupSpaceScope(scope.actorUserId, groupSpaceId);
  return membership !== null && canShareInto(membership.role);
}

/**
 * Whether a role in a group lets its holder share into that group. A viewer
 * cannot: putting an item in front of everyone in the group is a write in its
 * workspace (§23.3). One predicate, so the dialog's list of groups and the
 * POST that issues the grant cannot disagree.
 */
function canShareInto(role: string): boolean {
  return isGroupRole(role) && permissionsFor(role).write;
}

/** Every grant this owner has issued, newest first. */
export async function listOwnGrants(
  scope: SpaceScope,
  filters: GrantFilters = {},
  now: Date = new Date()
): Promise<GrantSummary[]> {
  const rows = await listOwnGrantRows(scope, filters, now);
  return toGrantSummaries(scope, rows, now);
}

/**
 * Amend a grant's role, detail flag or expiry.
 *
 * Returns `null` for a grant that is not this owner's, which the route turns
 * into a 404. The read-back is a second query and worth it: the client needs
 * the resulting row to render, and computing it from the request would mean
 * guessing at whatever the database actually stored.
 *
 * **Changing a grant to a group takes the same standing as issuing one**: a
 * joined membership of that group in a role that can write. Without it, the
 * rule {@link resolveGrantee} applies on POST could be stepped around with a
 * PATCH, and somebody who had left a group could still raise what it reads.
 * Any change needs it, not only a widening one: a leaver who wants the group to
 * see less can revoke, and {@link revokeGrant} asks for no membership at all.
 */
export async function updateGrant(
  scope: SpaceScope,
  id: string,
  input: UpdateGrantInput,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  if (!permissionsFor(scope.role).write) return null;

  const existing = await findOwnGrant(scope, id);
  if (!existing) return null;
  if (
    existing.granteeSpaceId !== null &&
    !(await canShareIntoSpace(scope, existing.granteeSpaceId))
  ) {
    return null;
  }

  const moved = await updateGrantRow(scope, id, {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.includeTaskDetail !== undefined
      ? { includeTaskDetail: input.includeTaskDetail }
      : {}),
    ...(input.expiry !== undefined ? { expiresAt: resolveExpiry(input.expiry, now) } : {}),
  });
  if (!moved) return null;

  const grant = await findOwnGrant(scope, id);
  if (!grant) return null;

  logger.info('Resparkable grant updated', { entityType: grant.entityType, role: grant.role });

  const [summary] = await toGrantSummaries(scope, [grant], now);
  return summary;
}

/**
 * Revoke a grant.
 *
 * Takes effect on the grantee's **next request** — nothing in the access layer
 * caches beyond one request, which is the property that makes this sentence
 * true rather than aspirational (§16.3).
 *
 * Returns `null` for a grant that is not this owner's **or is already revoked**,
 * so a double-press is a 404 rather than a second timestamp. The audit answer to
 * "when did access stop?" should not move because somebody clicked twice.
 */
export async function revokeGrant(
  scope: SpaceScope,
  id: string,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  if (!permissionsFor(scope.role).write) return null;

  const revoked = await revokeGrantRow(scope, id, now);
  if (!revoked) return null;

  const grant = await findOwnGrant(scope, id);
  if (!grant) return null;

  logger.info('Resparkable grant revoked', { entityType: grant.entityType });

  const [summary] = await toGrantSummaries(scope, [grant], now);
  return summary;
}

/**
 * The groups this workspace may share with (§23.7, phase 49).
 *
 * The caller's own **joined** groups, less the one whose workspace they are
 * in. Nothing else: §23.11 declined a public directory of groups, so sharing
 * with a group means being in it, and that rule lives in {@link issueGrant}
 * too rather than only in what this list happens to offer.
 *
 * Each carries its joined-member count, because §23.7 asks the dialog to name
 * the grantee group and how many people that is today.
 */
export async function listGrantTargetGroups(scope: SpaceScope): Promise<GroupLabel[]> {
  if (!scope.actorUserId) return [];
  // A workspace this caller cannot write in cannot issue a grant at all
  // (issueGrant's first check), so offering it groups would be offering a
  // button that always fails.
  if (!permissionsFor(scope.role).write) return [];

  const memberships = await listGroupsForActor(scope.actorUserId);
  const spaceIds = memberships
    .filter((membership) => membership.joinedAt !== null)
    .filter((membership) => canShareInto(membership.role))
    .map((membership) => membership.group.spaceId)
    .filter((spaceId) => spaceId !== scope.spaceId);

  const labels = await findGroupLabelsBySpaceIds(spaceIds);
  return [...labels.values()].sort((left, right) => left.name.localeCompare(right.name));
}
