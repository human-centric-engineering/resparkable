/**
 * Art. 15's other direction — the half `repo/**` cannot answer.
 *
 * ## The question the owner-scoped manifest could not ask
 *
 * `repo/subject-export.ts` answers "what is in this person's brain?", and every
 * source in it is `WHERE userId = $1`. Two things about a data subject live
 * outside that boundary by construction, and both have been sitting in that
 * file's comments as deferred:
 *
 *   • **What has been shared *with* them.** `ResparkableGrant.userId` is the
 *     owner, so a subject's own grants — the ones addressed to them — are on
 *     other people's rows.
 *   • **Comments they wrote** on somebody else's shared item. Keyed on
 *     `authorUserId`, on a row whose `userId` is the item's owner.
 *
 * Both are personal data about the subject and both are owed. Neither is
 * expressible as an owner query, which is why this file is in `access/**`:
 * reading across a person is exactly what this layer is named for, and routing
 * it through `repo/**` would mean giving that layer a way to say "not my rows".
 *
 * ## What is deliberately NOT in the answer
 *
 * **Not the content of what was shared with them.** A grant tells the subject
 * *that* Priya shared a project with them, on what terms, and when. It does not
 * put Priya's project in their export bundle — that is Priya's data, it is
 * behind a live grant that can be revoked, and an export file is a thing people
 * email around. The subject can read it in the product for as long as the grant
 * lasts; a permanent copy is not what Art. 15 asks for and would quietly turn
 * every share into a download.
 *
 * **Not the owner's identity beyond what the subject already sees.** They can
 * see who shared with them on `/shared-with-me`, so withholding it here would
 * be theatre — but the export carries the same fields that surface does and no
 * more.
 *
 * **Not the invite digest.** It is the digest of a credential and it tells the
 * subject nothing `acceptedAt` beside it does not.
 *
 * ## Phase 46 added a third question, and it is the same shape
 *
 * **Which groups is this person in, and what have they been invited to?**
 * `ResparkableGroupMember` and `ResparkableGroupInvite` carry no space key at
 * all, so the owner-scoped manifest cannot reach them by construction, exactly
 * as it could not reach a grant addressed to the subject. They are keyed on a
 * user id and a lower-cased address, which is the pair this file already
 * matches on.
 *
 * The release plan put these in `lib/privacy/export-sources.ts` instead. That
 * file is core-owned, and every Resparkable table is listed in its guard's
 * `HANDLED_OUTSIDE_MANIFEST` under sunrise#533 precisely because this tier
 * exports through the `lib/app/data-export.ts` seam and carries its own
 * completeness guard. Moving two rows into the core manifest would reverse that
 * arrangement for two tables and leave the other 24 where they are.
 *
 * What the subject gets, and what they do not: the groups they belong to, by
 * name, with their role and when they joined; invitations addressed to them,
 * accepted or not; and invitations they sent, by group and date. **Not the
 * group's content.** That is the group's, it sits behind a live membership, and
 * the same reasoning applies as for a grant: an export bundle is a file that
 * gets emailed around.
 *
 * ## Phase 48: what they wrote in a group IS theirs
 *
 * "Not the group's content" has one exception, and §23.6 names it: rows in a
 * group space whose `createdByUserId` is the subject. What a person wrote is
 * their personal data wherever they wrote it, and the owner-scoped manifest
 * cannot see it, because a group space is not theirs.
 *
 * This is the first source in the tier whose answer is **some** of a table's
 * rows rather than all of them, and saying so is the whole obligation. Core's
 * `scopeNote` would be the place, but that field exists only on core's own
 * manifest; the registry this tier declares through carries a `description`
 * and nothing else (Sunrise ask #47). So the narrowing is stated in the
 * section's description in `lib/app/data-export.ts`, which core surfaces in the
 * export's own `meta.app` beside the section's row count. The text is
 * {@link GROUP_CONTRIBUTIONS_SCOPE_NOTE}.
 *
 * The section is an array of groups rather than an object carrying the note,
 * because core counts an object section as one row, and a count that always
 * reads "1" would be a small lie in the one place a reader checks.
 *
 * Organised by group, one entry per group the subject wrote in, because "the
 * tasks you wrote" means nothing without "in which group". Groups they have
 * since left are included: leaving does not make what they wrote any less
 * theirs, and rows they wrote in a deleted group are gone with it.
 */

import { prisma } from '@/lib/db/client';
import type { ResparkableViewer } from '@/lib/framework/resparkable/access/types';

/** One item somebody else has shared with the subject. */
export interface SharedWithMeRecord {
  entityType: string;
  /**
   * The item's id, and deliberately not its title.
   *
   * The id is what makes the record checkable against the product — a subject
   * disputing "you say this was shared with me" can be shown the same row. The
   * title is the owner's content, and see the header for why content stays out.
   */
  entityId: string;
  role: string;
  includeTaskDetail: boolean;
  sharedAt: Date;
  acceptedAt: Date | null;
  invitedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** One comment the subject wrote on somebody else's item. */
export interface AuthoredCommentRecord {
  entityType: string;
  entityId: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
}

/** One group the subject belongs to. */
export interface GroupMembershipRecord {
  groupId: string;
  /**
   * The group's name, and deliberately not its space id.
   *
   * The name is the only way the record means anything to the person reading
   * it: "you are an admin of Study Group B" is checkable, "you are an admin of
   * cm3x9…" is not. The space key is the partition key of other people's
   * content and belongs nowhere near an export bundle.
   */
  groupName: string;
  role: string;
  /** Null while a request to join is still pending approval (§23.11). */
  joinedAt: Date | null;
  invitedAt: Date;
}

/** One invitation, either addressed to the subject or sent by them. */
export interface GroupInviteRecord {
  groupId: string;
  groupName: string;
  /**
   * `received` when the invite is addressed to the subject, `sent` when they
   * issued it. Both are the subject's personal data and they are different
   * facts about them, so collapsing them into one list would answer neither
   * question honestly.
   */
  direction: 'received' | 'sent';
  role: string;
  invitedAt: Date;
  acceptedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * What `groupContributions` withholds, and why. Declared as the section's
 * description, which core prints in the export's `meta.app` beside its count.
 */
export const GROUP_CONTRIBUTIONS_SCOPE_NOTE =
  'Only rows you created in each group workspace. Rows other members created are theirs and ' +
  'are not included, even where you later edited them. Each row is shown as it is now, which ' +
  'may include later edits by other members. Comments you wrote in a group are in ' +
  'commentsIWrote. Your personal workspace is exported in full in its own sections.';

/** The rows the subject wrote in one group's workspace. */
export interface GroupContributionRecord {
  groupId: string;
  groupName: string;
  /** False when they have since left, or their membership is still pending. */
  currentMember: boolean;
  /**
   * Their rows, by the same section names the personal export uses, with
   * `spaceId` removed: it is the partition key of other people's content, and
   * the group's name says which workspace a row is from.
   */
  rows: Record<string, Array<Record<string, unknown>>>;
}

export interface ResparkableCrossSubjectData {
  /** Grants addressed to this person, by anybody. */
  sharedWithMe: SharedWithMeRecord[];
  /** Comments this person wrote, wherever they wrote them. */
  commentsIWrote: AuthoredCommentRecord[];
  /** Groups this person belongs to, pending memberships included. */
  groupMemberships: GroupMembershipRecord[];
  /** Group invitations addressed to them, and ones they sent. */
  groupInvites: GroupInviteRecord[];
  /** What they wrote in each group workspace. See {@link GROUP_CONTRIBUTIONS_SCOPE_NOTE}. */
  groupContributions: GroupContributionRecord[];
}

/**
 * The tier's models whose subject data is answered HERE rather than by the
 * owner-scoped manifest, because they carry no space key.
 *
 * Read by `tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts`,
 * which scans the schema for models holding a user id and NO `spaceId`. Those
 * are exactly the tables `repo/subject-export.ts` cannot reach, and before this
 * set existed they were the tier guard's blind spot: it scanned for `spaceId`,
 * so a table keyed on a person alone was invisible to it and would have been
 * omitted from an export in silence.
 *
 * `ResparkableGrant` and `ResparkableComment` are NOT here, even though this
 * file reads both. They carry a `spaceId` (the owner's), so the owner-scoped
 * manifest already claims them and the guard already sees them; what this file
 * adds for those two is the other direction, not the only coverage.
 */
export const RESPARKABLE_CROSS_SUBJECT_MODELS = [
  'ResparkableGroupMember',
  'ResparkableGroupInvite',
] as const;

/**
 * The model the `groupContributions` section is declared under.
 *
 * A declaration needs one real model, and the section spans eighteen tables,
 * every one of which the owner-scoped manifest already claims. The group is
 * what the section is organised by, so it is the honest name for it. The group
 * ROW is still not exported: only its id and name, as labels on the subject's
 * own rows. `subject-export.test.ts` accepts this as the third way a scoped
 * model can be accounted for, beside exported and excluded.
 */
export const RESPARKABLE_GROUP_CONTRIBUTION_MODEL = 'ResparkableGroup';

/** The predicate, in one place: rows this person wrote, in any group space. */
function contributedBy(userId: string) {
  return { createdByUserId: userId, space: { kind: 'group' } };
}

const OLDEST_FIRST = { createdAt: 'asc' } as const;

/**
 * Every table a member can write into, by the section name the personal export
 * gives it.
 *
 * Absent, each for a reason: the space row (the group's, not theirs), credit
 * rows (a group has no account until phase 50), embeddings and jobs (derived,
 * excluded from the personal export on the same grounds), and comments (already
 * complete in `commentsIWrote`, which matches on `authorUserId` in every space).
 * `subject-export.test.ts` asserts this list against the owner-scoped manifest,
 * so a table added there and not here fails by name.
 */
export const GROUP_CONTRIBUTION_SOURCES: Record<
  string,
  { section: string; fetch: (userId: string) => Promise<Array<Record<string, unknown>>> }
> = {
  ResparkableArea: {
    section: 'areas',
    fetch: (userId) =>
      prisma.resparkableArea.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableGoal: {
    section: 'goals',
    fetch: (userId) =>
      prisma.resparkableGoal.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableProject: {
    section: 'projects',
    fetch: (userId) =>
      prisma.resparkableProject.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableTask: {
    section: 'tasks',
    fetch: (userId) =>
      prisma.resparkableTask.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableThought: {
    section: 'thoughts',
    fetch: (userId) =>
      prisma.resparkableThought.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableLink: {
    section: 'links',
    fetch: (userId) =>
      prisma.resparkableLink.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableBoard: {
    section: 'boards',
    fetch: (userId) =>
      prisma.resparkableBoard.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableBoardCard: {
    section: 'boardCards',
    fetch: (userId) =>
      prisma.resparkableBoardCard.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableTag: {
    section: 'tags',
    fetch: (userId) =>
      prisma.resparkableTag.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableTaskTag: {
    section: 'taskTags',
    fetch: (userId) =>
      prisma.resparkableTaskTag.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableChecklistItem: {
    section: 'checklistItems',
    fetch: (userId) =>
      prisma.resparkableChecklistItem.findMany({
        where: contributedBy(userId),
        orderBy: OLDEST_FIRST,
      }),
  },
  ResparkableEntity: {
    section: 'people',
    fetch: (userId) =>
      prisma.resparkableEntity.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableDocument: {
    section: 'documents',
    fetch: (userId) =>
      prisma.resparkableDocument.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableTimeBlock: {
    section: 'timeBlocks',
    fetch: (userId) =>
      prisma.resparkableTimeBlock.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableReview: {
    section: 'reviews',
    fetch: (userId) =>
      prisma.resparkableReview.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableEvent: {
    section: 'activity',
    fetch: (userId) =>
      prisma.resparkableEvent.findMany({ where: contributedBy(userId), orderBy: OLDEST_FIRST }),
  },
  ResparkableGrant: {
    section: 'sharedByMe',
    // The same omission the personal export makes: the digest of a credential.
    fetch: (userId) =>
      prisma.resparkableGrant.findMany({
        where: contributedBy(userId),
        omit: { inviteTokenHash: true },
        orderBy: OLDEST_FIRST,
      }),
  },
  ResparkableShareLink: {
    section: 'shareLinks',
    // And again: `tokenHash` is the credential.
    fetch: (userId) =>
      prisma.resparkableShareLink.findMany({
        where: contributedBy(userId),
        omit: { tokenHash: true },
        orderBy: OLDEST_FIRST,
      }),
  },
};

/**
 * Collect what one person wrote in group workspaces, grouped by group.
 *
 * Reads each table once for the person, not once per group, then labels the
 * rows. A person in many groups gets eighteen queries, not eighteen per group.
 */
export async function collectGroupContributions(
  userId: string,
  memberships: ReadonlyArray<{ groupId: string; joinedAt: Date | null }>
): Promise<GroupContributionRecord[]> {
  const entries = Object.values(GROUP_CONTRIBUTION_SOURCES);
  const results = await Promise.all(entries.map((source) => source.fetch(userId)));

  const bySpace = new Map<string, Record<string, Array<Record<string, unknown>>>>();
  entries.forEach((source, i) => {
    for (const row of results[i]) {
      const { spaceId, ...rest } = row;
      if (typeof spaceId !== 'string') continue;
      const sections = bySpace.get(spaceId) ?? {};
      (sections[source.section] ??= []).push(rest);
      bySpace.set(spaceId, sections);
    }
  });
  if (bySpace.size === 0) return [];

  const groups = await prisma.resparkableGroup.findMany({
    where: { spaceId: { in: [...bySpace.keys()] } },
    select: { id: true, name: true, spaceId: true },
    orderBy: { createdAt: 'asc' },
  });
  const joined = new Set(
    memberships.filter((member) => member.joinedAt !== null).map((member) => member.groupId)
  );

  return groups.map((group) => ({
    groupId: group.id,
    groupName: group.name,
    currentMember: joined.has(group.id),
    rows: bySpace.get(group.spaceId) ?? {},
  }));
}

/**
 * Everything about this subject that lives on somebody else's rows.
 *
 * **Includes revoked and expired grants**, unlike `/shared-with-me`. That
 * surface is a place to work from and a withdrawn share is not part of it; this
 * is a record of what was done with the subject's personal data, and "somebody
 * shared a project with you last March and withdrew it in April" is exactly the
 * kind of thing a subject-access request is for.
 *
 * Matched on **both** the account id and the lower-cased address, the same pair
 * `granteeClauses` matches on — an unaccepted invite has only the address, and
 * an export that dropped those would silently omit the grants most likely to
 * have been forgotten about.
 */
export async function collectResparkableCrossSubjectData(
  // The person, and not a workspace. An export is about the subject wherever
  // their data sits, so it takes the two identity fields and never a group:
  // what was shared with a group is the group's, and is not the subject's
  // personal data unless they wrote it (`groupContributions`).
  viewer: Pick<ResparkableViewer, 'userId' | 'email'>
): Promise<ResparkableCrossSubjectData> {
  const clauses = [];
  if (viewer.userId) clauses.push({ granteeUserId: viewer.userId });
  if (viewer.email) clauses.push({ granteeEmail: viewer.email.toLowerCase() });

  // No identity at all is not a subject. An unfiltered `OR: []` would match
  // every grant in the installation, which is the one failure mode here worth
  // spending a branch on.
  if (clauses.length === 0 || !viewer.userId) {
    return {
      sharedWithMe: [],
      commentsIWrote: [],
      groupMemberships: [],
      groupInvites: [],
      groupContributions: [],
    };
  }
  const actorUserId = viewer.userId;
  const address = viewer.email?.toLowerCase() ?? null;

  const [grants, comments, memberships, invites] = await Promise.all([
    prisma.resparkableGrant.findMany({
      where: { OR: clauses },
      select: {
        entityType: true,
        entityId: true,
        role: true,
        includeTaskDetail: true,
        createdAt: true,
        acceptedAt: true,
        inviteSentAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.resparkableComment.findMany({
      where: { authorUserId: viewer.userId },
      select: {
        entityType: true,
        entityId: true,
        body: true,
        editedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    // Pending memberships included. A request to join that is still waiting on
    // an admin is a fact about this person that they may well want to see, and
    // filtering it out here would make the export disagree with the product.
    prisma.resparkableGroupMember.findMany({
      where: { userId: actorUserId },
      select: {
        groupId: true,
        role: true,
        joinedAt: true,
        // When they were emailed that they are the group's only admin: a
        // record of something done with their address, so theirs to see.
        soleAdminNotifiedAt: true,
        createdAt: true,
        group: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    // Both directions in one read. Revoked and expired invitations are kept,
    // for the reason the grant query keeps withdrawn shares: this is a record of
    // what was done with the subject's personal data, and "you were invited to
    // that group in March and it was withdrawn in April" is exactly what a
    // subject-access request is for.
    prisma.resparkableGroupInvite.findMany({
      where: {
        OR: [...(address ? [{ email: address }] : []), { invitedByUserId: actorUserId }],
      },
      select: {
        groupId: true,
        email: true,
        role: true,
        invitedByUserId: true,
        createdAt: true,
        acceptedAt: true,
        expiresAt: true,
        revokedAt: true,
        group: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const contributions = await collectGroupContributions(actorUserId, memberships);

  return {
    // An allowlisted `select` rather than an `omit`, unlike every owner-scoped
    // source in the tier. The inversion is the same one `repo/shared-view.ts`
    // makes and for the same reason: these rows belong to somebody else, so a
    // column added to `ResparkableGrant` next month must not reach a third
    // party's export bundle because nobody remembered to exclude it.
    sharedWithMe: grants.map((grant) => ({
      entityType: grant.entityType,
      entityId: grant.entityId,
      role: grant.role,
      includeTaskDetail: grant.includeTaskDetail,
      sharedAt: grant.createdAt,
      acceptedAt: grant.acceptedAt,
      invitedAt: grant.inviteSentAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })),
    commentsIWrote: comments,
    groupMemberships: memberships.map((member) => ({
      groupId: member.groupId,
      groupName: member.group.name,
      role: member.role,
      joinedAt: member.joinedAt,
      invitedAt: member.createdAt,
    })),
    // An invite the subject sent to their own address would otherwise appear
    // twice. `received` wins, because "somebody invited me" is the fact the
    // subject is more likely to be asking about.
    groupInvites: invites.map((invite) => ({
      groupId: invite.groupId,
      groupName: invite.group.name,
      direction: address !== null && invite.email === address ? 'received' : 'sent',
      role: invite.role,
      invitedAt: invite.createdAt,
      acceptedAt: invite.acceptedAt,
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
    })),
    groupContributions: contributions,
  };
}
