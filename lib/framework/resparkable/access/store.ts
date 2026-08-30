/**
 * Every database read the sharing layer makes, and nothing else.
 *
 * ## Why this file may import Prisma when almost nothing else in the tier can
 *
 * The tier-wide ESLint rule keeps `@/lib/db/client` unreachable outside
 * `repo/**`, because a repo function takes an `SpaceScope` and therefore cannot
 * express a cross-user read. This directory is the deliberate second case (D5):
 * **shared queries opt in explicitly**, and a shared query is by definition one
 * that reads rows belonging to someone other than the caller. Routing it
 * through `repo/**` would mean giving the repo layer a way to say "not my
 * rows", which is exactly the capability that layer exists not to have.
 *
 * So the boundary is not "one layer touches the database". It is:
 *
 *   • `repo/**` — owner queries. Takes an `SpaceScope`. Cannot cross a user.
 *   • `access/**` — shared queries. Takes a viewer. Crosses a user only by
 *     following a grant or a link, and every function here is named for the
 *     grant or link it follows.
 *
 * And `repo/**` may not import this directory, which is what stops the two
 * collapsing back into one.
 *
 * ## Two disciplines every function here keeps
 *
 *   1. **Batched or single, never per row.** Tasks are the highest-cardinality
 *      shareable type and a shared board is a list of them, so a resolver that
 *      queried per card would make sharing a board quadratic. Every read has a
 *      plural form and the resolver uses it.
 *   2. **No archive filter.** An archived item with a live share link still
 *      resolves at its public URL (§16.1c): the owner retired the thinking,
 *      they did not revoke the link, and a reader following a URL they were
 *      given should see what it points at rather than a 404 they cannot
 *      explain. Revocation is the gesture that closes a link.
 */

import { prisma } from '@/lib/db/client';
import {
  type LiveGrant,
  type LiveShareLink,
  type ResparkableEntityRef,
  type ResparkableShareableType,
  type ResparkableViewer,
  isResparkableShareableType,
} from '@/lib/framework/resparkable/access/types';
import { isShareActive } from '@/lib/utils/share-window';
import { Prisma } from '@prisma/client';

/** What every owner lookup selects: an id and the column the decision turns on. */
const OWNER_SELECT = { id: true, spaceId: true } as const;

/**
 * Owner ids for a batch of items of one type.
 *
 * The first query of every resolution and, for an item the caller owns, the
 * only one. Selects `userId` alone: the resolver's next step is a string
 * comparison, and fetching a whole row to compare one column would put a user's
 * entire note body on the wire for an authorisation check.
 *
 * A `switch` rather than a delegate lookup table because Prisma's delegates do
 * not share a common structural type — and the switch buys something the table
 * could not: the `never` arm below makes adding a shareable type without an
 * owner lookup a **compile error**, rather than an `undefined` delegate at
 * runtime on an authorisation path.
 *
 * A missing id is simply absent from the map. The caller reads that as a
 * denial, which is correct for both reasons it can happen — the row does not
 * exist, or it does and this is not the reader's business.
 */
export async function findEntityOwners(
  entityType: ResparkableShareableType,
  entityIds: readonly string[]
): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map();

  const where = { id: { in: [...entityIds] } };

  const rows = await (async (): Promise<Array<{ id: string; spaceId: string }>> => {
    switch (entityType) {
      case 'area':
        return prisma.resparkableArea.findMany({ where, select: OWNER_SELECT });
      case 'goal':
        return prisma.resparkableGoal.findMany({ where, select: OWNER_SELECT });
      case 'project':
        return prisma.resparkableProject.findMany({ where, select: OWNER_SELECT });
      case 'review':
        return prisma.resparkableReview.findMany({ where, select: OWNER_SELECT });
      case 'board':
        return prisma.resparkableBoard.findMany({ where, select: OWNER_SELECT });
      case 'task':
        return prisma.resparkableTask.findMany({ where, select: OWNER_SELECT });
      default: {
        const unreachable: never = entityType;
        throw new Error(`findEntityOwners: no owner lookup for "${String(unreachable)}"`);
      }
    }
  })();

  return new Map(rows.map((row) => [row.id, row.spaceId]));
}

/** Single form, for the common one-item route. */
export async function findEntityOwner(
  entityType: ResparkableShareableType,
  entityId: string
): Promise<string | null> {
  const owners = await findEntityOwners(entityType, [entityId]);
  return owners.get(entityId) ?? null;
}

/**
 * The `where` that matches this viewer's grants, whichever half of their
 * identity the grant was addressed to.
 *
 * A grant is issued to an **email** and only gains a `granteeUserId` when it is
 * accepted, so a person whose account exists but who has never opened the
 * invite is found by the address alone. Matching on both is what makes the
 * invite flow's "you already had an account" path work without a second table.
 *
 * Returns `null` for a viewer with neither, which the callers turn into an
 * empty result rather than a query — an unfiltered `OR: []` would match every
 * grant in the install.
 */
function granteeClauses(viewer: ResparkableViewer): Prisma.ResparkableGrantWhereInput[] | null {
  const clauses: Prisma.ResparkableGrantWhereInput[] = [];
  if (viewer.userId) clauses.push({ granteeUserId: viewer.userId });
  if (viewer.email) clauses.push({ granteeEmail: viewer.email.toLowerCase() });
  return clauses.length > 0 ? clauses : null;
}

const GRANT_SELECT = {
  id: true,
  spaceId: true,
  entityType: true,
  entityId: true,
  role: true,
  includeTaskDetail: true,
  acceptedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** Shape a grant row, dropping any whose type is no longer shareable. */
function toLiveGrants(
  rows: Array<{
    id: string;
    spaceId: string;
    entityType: string;
    entityId: string;
    role: string;
    includeTaskDetail: boolean;
    acceptedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }>,
  now: Date
): LiveGrant[] {
  return rows
    .filter((row) => isResparkableShareableType(row.entityType))
    .filter((row) => isShareActive(row, now))
    .map((row) => ({
      id: row.id,
      ownerId: row.spaceId,
      entityType: row.entityType as ResparkableShareableType,
      entityId: row.entityId,
      // Anything that is not `commenter` reads as `viewer`. Widening a role by
      // typo is the failure worth preventing; narrowing one is visible.
      role: row.role === 'commenter' ? 'commenter' : 'viewer',
      includeTaskDetail: row.includeTaskDetail,
      acceptedAt: row.acceptedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
}

/**
 * Every live grant this viewer holds, across every owner.
 *
 * One query, and the whole input to {@link resparkableVisibilityScope}. A
 * person is granted a handful of items, not thousands, so reading them all is
 * cheaper than asking per item and lets a list resolve twenty rows without
 * twenty queries.
 *
 * Expiry is filtered in JS rather than in SQL on purpose: `isShareActive` is
 * the single definition of "still live" (`lib/utils/share-window.ts`), shared
 * with the admin conversation shares, and a `where` clause here would be a
 * second copy of it that could drift.
 */
export async function findLiveGrantsForViewer(
  viewer: ResparkableViewer,
  now: Date = new Date()
): Promise<LiveGrant[]> {
  const grantee = granteeClauses(viewer);
  if (!grantee) return [];

  const rows = await prisma.resparkableGrant.findMany({
    where: { revokedAt: null, OR: grantee },
    select: GRANT_SELECT,
    orderBy: { createdAt: 'desc' },
  });

  return toLiveGrants(rows, now);
}

/**
 * Live grants this viewer holds on any of the given refs.
 *
 * The batched form used when resolving a list: one query covering both the
 * items asked about and their cascade parents, rather than one per item. Refs
 * are matched as `(entityType, entityId)` pairs, so a board id can never be
 * read as a grant on a task that happens to share it — ids are cuids and
 * collision is not the risk; a careless `entityId: { in: [...] }` with no type
 * predicate is.
 */
export async function findLiveGrantsForRefs(
  viewer: ResparkableViewer,
  refs: readonly ResparkableEntityRef[],
  now: Date = new Date()
): Promise<LiveGrant[]> {
  const grantee = granteeClauses(viewer);
  if (!grantee || refs.length === 0) return [];

  const rows = await prisma.resparkableGrant.findMany({
    where: {
      revokedAt: null,
      // Two independent ORs, so they must be ANDed explicitly: a single `OR`
      // key holding both sets would match a grant to ANYONE on one of these
      // refs, which is the leak this whole layer exists to prevent.
      AND: [
        { OR: grantee },
        { OR: refs.map((ref) => ({ entityType: ref.entityType, entityId: ref.entityId })) },
      ],
    },
    select: GRANT_SELECT,
  });

  return toLiveGrants(rows, now);
}

/**
 * Resolve a public link by the sha256 of its token.
 *
 * **The plaintext token never reaches this function and is never stored.** The
 * caller hashes; this looks the digest up in a unique index. A database dump
 * therefore hands over no working links, which is the whole reason this table
 * deviates from the plaintext-cuid precedent of `AiAgentEmbedToken`.
 *
 * Returns `null` for unknown, revoked, expired and not-a-shareable-type alike.
 * That is deliberate and it is what §16.4 asks for: **tampered, revoked and
 * expired must be indistinguishable from outside**, or the 404 becomes an
 * oracle telling a stranger which tokens once existed.
 */
export async function findLiveShareLinkByTokenHash(
  tokenHash: string,
  now: Date = new Date()
): Promise<LiveShareLink | null> {
  const row = await prisma.resparkableShareLink.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      spaceId: true,
      entityType: true,
      entityId: true,
      includeChildren: true,
      includeTaskDetail: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!row) return null;
  if (!isResparkableShareableType(row.entityType)) return null;
  if (!isShareActive(row, now)) return null;

  return {
    id: row.id,
    ownerId: row.spaceId,
    entityType: row.entityType,
    entityId: row.entityId,
    includeChildren: row.includeChildren,
    includeTaskDetail: row.includeTaskDetail,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

// ─── Cascade lookups ─────────────────────────────────────────────────────────

/**
 * A task's parent project ids, batched.
 *
 * Scoped to the owner even though ids are cuids: the cascade only ever runs
 * within one owner's brain, and stating it in the query means a future caller
 * that passes ids from two owners gets nothing rather than a cross-owner edge.
 */
export async function findTaskProjects(
  ownerId: string,
  taskIds: readonly string[]
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();

  const rows = await prisma.resparkableTask.findMany({
    // Same rule as `findGoalParents`, and it matters more here because tasks
    // reach the cascade two ways. `findSharedChildIds` lists a project's tasks
    // with `archivedAt: null`, and `loadFilteredCards` reaches a filter board's
    // cards through `listTasks`, whose default `taskWhere` excludes archived
    // rows too. An archived task is therefore rendered by nothing, and a
    // cascade that still granted it would hand out exactly what this file's
    // header calls the unsafe direction: access to a row the board never showed.
    where: { spaceId: ownerId, id: { in: [...taskIds] }, archivedAt: null },
    select: { id: true, projectId: true, status: true },
  });

  return new Map(
    rows
      .filter((row): row is typeof row & { projectId: string } => row.projectId !== null)
      .map((row) => [row.id, row.projectId])
  );
}

/** A goal's parent goal ids, batched. One level — see `cascade.ts`. */
export async function findGoalParents(
  ownerId: string,
  goalIds: readonly string[]
): Promise<Map<string, string>> {
  if (goalIds.length === 0) return new Map();

  const rows = await prisma.resparkableGoal.findMany({
    // Archived goals have no cascade parent. `findSharedChildIds` renders a
    // parent goal's children with `archivedAt: null`, so a cascade that still
    // reached them would grant access to something no shared surface displays.
    // An archived goal shared DIRECTLY still resolves: that is the owner's own
    // gesture, and it is settled before the cascade runs.
    where: { spaceId: ownerId, id: { in: [...goalIds] }, archivedAt: null },
    select: { id: true, parentGoalId: true },
  });

  return new Map(
    rows
      .filter((row): row is typeof row & { parentGoalId: string } => row.parentGoalId !== null)
      .map((row) => [row.id, row.parentGoalId])
  );
}

/** The `(taskId, projectId, status)` triples the board cascade needs. */
export interface TaskFacts {
  id: string;
  projectId: string | null;
  status: string;
}

export async function findTaskFacts(
  ownerId: string,
  taskIds: readonly string[]
): Promise<Map<string, TaskFacts>> {
  if (taskIds.length === 0) return new Map();

  const rows = await prisma.resparkableTask.findMany({
    // Same rule as `findGoalParents`, and it matters more here because tasks
    // reach the cascade two ways. `findSharedChildIds` lists a project's tasks
    // with `archivedAt: null`, and `loadFilteredCards` reaches a filter board's
    // cards through `listTasks`, whose default `taskWhere` excludes archived
    // rows too. An archived task is therefore rendered by nothing, and a
    // cascade that still granted it would hand out exactly what this file's
    // header calls the unsafe direction: access to a row the board never showed.
    where: { spaceId: ownerId, id: { in: [...taskIds] }, archivedAt: null },
    select: { id: true, projectId: true, status: true },
  });

  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Board ids that pin these tasks explicitly, batched.
 *
 * **Only boards still on `membership: 'explicit'`.** `updateBoard` lets a board
 * flip from explicit to filter and deletes none of its cards, and
 * `loadFilteredCards` ignores the card table entirely. So a board curated,
 * shared, then switched to a filter would otherwise keep granting every task it
 * was ever pinned with, for ever, with nothing in the UI hinting at it. Unlike
 * an archived row, that one does not heal.
 */
export async function findBoardsPinningTasks(
  ownerId: string,
  taskIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (taskIds.length === 0) return new Map();

  const rows = await prisma.resparkableBoardCard.findMany({
    where: {
      spaceId: ownerId,
      taskId: { in: [...taskIds] },
      board: { membership: 'explicit' },
    },
    select: { taskId: true, boardId: true },
  });

  const byTask = new Map<string, string[]>();
  for (const row of rows) {
    const boards = byTask.get(row.taskId);
    if (boards) boards.push(row.boardId);
    else byTask.set(row.taskId, [row.boardId]);
  }
  return byTask;
}

/** One owner's filter-backed boards, with the filter and columns to evaluate. */
export interface FilterBoard {
  id: string;
  filter: unknown;
  columns: unknown;
}

/**
 * Every filter-backed board this owner has.
 *
 * Read whole rather than queried per task because the set is small — a person
 * has a handful of boards, not thousands — and because "does task T match board
 * B" is a predicate over B's stored filter, which has to be parsed in code
 * anyway (`cascade.ts`). One query for the boards beats one query per task.
 */
export async function findFilterBoards(ownerId: string): Promise<FilterBoard[]> {
  return prisma.resparkableBoard.findMany({
    where: { spaceId: ownerId, membership: 'filter' },
    select: { id: true, filter: true, columns: true },
  });
}
