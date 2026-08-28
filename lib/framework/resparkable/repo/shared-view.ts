/**
 * What a shared reader actually sees — the projection, and nothing else.
 *
 * ## Why this is an owner-scoped repo module and not part of `access/**`
 *
 * The two answer different questions. `access/**` answers **"may this viewer
 * see this?"** and is allowed to read across users to find out. By the time
 * this runs that question is settled and the owner is known — so loading the
 * content is an ordinary owner query, and it belongs in the layer that cannot
 * express anything else. Giving the shared-query layer the ability to read
 * arbitrary content would widen it from "follow a grant" to "read a brain".
 *
 * The `OwnerScope` comes from `sharedOwnerScope()`, which mints one only from a
 * positive `ResparkableAccessResult`. There is no path from a token or a route
 * param to a scope.
 *
 * ## The projection is an allowlist, and this is the one place it should be
 *
 * Everywhere else in this tier the rule is `omit`, not `select` — a column
 * added tomorrow should be exported by default rather than silently dropped.
 * **Here it is inverted on purpose.** A column added to `ResparkableTask`
 * tomorrow must NOT appear on a public page because nobody remembered to
 * exclude it. Export answers to the person the data is about; this answers to a
 * stranger, and the safe default runs the other way.
 *
 * Fields deliberately absent, and worth stating: `priorityScore`,
 * `priorityFactors`, `manualBoost`, `manualBoostReason`, `snoozeCount`,
 * `deferUntil`, `energy`, `estimateMinutes`, `contextTag`, `lastActivityAt`,
 * `slug`, `rev`, `indexedHash`, `visibility`, every foreign key, a board's
 * `filter`, a review's `payload`, and the whole of `ResparkableEvent`. None of
 * it is a stranger's business, and several — a score, a boost rationale — are
 * the owner's private opinion of their own work.
 *
 * ## Plural first
 *
 * Every read here has a batched form and the singular delegates to it. A shared
 * project is a list of tasks and a shared board is a list of cards; a
 * per-child query would make one page load two hundred round trips.
 */

import { prisma } from '@/lib/db/client';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

/** One item, rendered. Deliberately uniform across six very different tables. */
export interface SharedItemView {
  entityType: ResparkableShareableType;
  id: string;
  title: string;
  /** Markdown. Rendered with no raw HTML; `null` when the item has no prose. */
  body: string | null;
  /** The item's own status word, where it has one. */
  status: string | null;
  dueAt: Date | null;
  /** Only on the types that have one, and only where it means something. */
  horizon: string | null;
  archived: boolean;
  updatedAt: Date;
  /** Tag names only — never colours, never ids a reader could probe. */
  tags: string[];
  /** `null` when there is no checklist, so the UI can tell empty from absent. */
  checklist: { done: number; total: number } | null;
}

/** How many children one share renders. See {@link findSharedChildIds}. */
export const SHARED_CHILD_LIMIT = 200;

/**
 * What {@link findSharedChildIds} actually asks the database for.
 *
 * One more than it will render, so the caller can tell "exactly at the limit"
 * from "more than the limit" without a second `count`. Comparing a full page
 * against the limit cannot: a project with exactly 200 live tasks would tell
 * every reader there were more, which is the same lie as truncating silently,
 * told in the other direction.
 */
const CHILD_PROBE = SHARED_CHILD_LIMIT + 1;

/**
 * Load a batch of items of one type for a shared reader.
 *
 * `withDetail` opens the prose on a **task** only. Every other type's body IS
 * the item — a project with its description withheld is a title — whereas a
 * task's `notes` is private working commentary beside a one-line title. That
 * asymmetry is §13's, and it is why the flag is called `includeTaskDetail`
 * rather than `includeBody`.
 *
 * Ids that are not the owner's, or do not exist, are simply absent from the
 * result. The caller renders what came back, which turns both into the same
 * nothing.
 */
export async function findSharedItems(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityIds: readonly string[],
  withDetail: boolean
): Promise<SharedItemView[]> {
  if (entityIds.length === 0) return [];

  const where = { ...ownerWhere(scope), id: { in: [...entityIds] } };

  switch (entityType) {
    case 'area': {
      const rows = await prisma.resparkableArea.findMany({
        where,
        select: { id: true, name: true, description: true, archivedAt: true, updatedAt: true },
      });
      return rows.map((row) => base(entityType, row.id, row.name, row.description, row));
    }

    case 'goal': {
      const rows = await prisma.resparkableGoal.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          horizon: true,
          status: true,
          targetDate: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        ...base(entityType, row.id, row.title, row.description, row),
        status: row.status,
        horizon: row.horizon,
        // A goal's target date IS its due date, and a goal without one reads as
        // an aspiration rather than a commitment. Same field, same column.
        dueAt: row.targetDate,
      }));
    }

    case 'project': {
      const rows = await prisma.resparkableProject.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        ...base(entityType, row.id, row.name, row.description, row),
        status: row.status,
      }));
    }

    case 'review': {
      // `payload` is deliberately absent: structured working data the
      // generating workflow left behind — item ids, scores, intermediate
      // reasoning — none of it a reader's business.
      const rows = await prisma.resparkableReview.findMany({
        where,
        select: {
          id: true,
          title: true,
          body: true,
          horizon: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        ...base(entityType, row.id, row.title, row.body, row),
        horizon: row.horizon,
      }));
    }

    case 'board': {
      // `filter` is absent on purpose. Publishing it would tell a reader what
      // the owner's projects are called and how they slice their work — that is
      // metadata about the brain rather than content from it.
      const rows = await prisma.resparkableBoard.findMany({
        where,
        select: { id: true, name: true, description: true, archivedAt: true, updatedAt: true },
      });
      return rows.map((row) => base(entityType, row.id, row.name, row.description, row));
    }

    case 'task': {
      const rows = await prisma.resparkableTask.findMany({
        where,
        select: {
          id: true,
          title: true,
          notes: true,
          status: true,
          dueAt: true,
          archivedAt: true,
          updatedAt: true,
          tags: { select: { tag: { select: { name: true } } } },
          checklist: { select: { isDone: true } },
        },
      });
      return rows.map((row) => ({
        ...base(entityType, row.id, row.title, withDetail ? row.notes : null, row),
        status: row.status,
        dueAt: row.dueAt,
        tags: row.tags.map((link) => link.tag.name),
        // Progress, never the items themselves: "3 of 7" says how far along the
        // work is; the item text is the working commentary `notes` also is.
        checklist: row.checklist.length
          ? {
              done: row.checklist.filter((item) => item.isDone).length,
              total: row.checklist.length,
            }
          : null,
      }));
    }

    default: {
      const unreachable: never = entityType;
      throw new Error(`findSharedItems: no projection for "${String(unreachable)}"`);
    }
  }
}

/** Singular form, for the one-item route. */
export async function findSharedItem(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityId: string,
  withDetail: boolean
): Promise<SharedItemView | null> {
  const [item] = await findSharedItems(scope, entityType, [entityId], withDetail);
  return item ?? null;
}

/**
 * The ids the one-level typed cascade reaches, owner-scoped.
 *
 * Ordered the way a reader expects rather than the way the owner ranks:
 * **never by `priorityScore`**, which is precisely the field a shared view must
 * not disclose — ordering by it would leak the ranking through the sequence
 * even with the number withheld.
 *
 * Capped at {@link SHARED_CHILD_LIMIT}. A shared project with two thousand
 * tasks is a page nobody can read and a query nobody asked for.
 *
 * **A board is not handled here.** A filter-backed board's membership is a live
 * query owned by `services/board-view.ts`, and `services/sharing.ts` asks that
 * module rather than this one — a second copy of the filter predicate is
 * exactly the thing `access/cascade.ts` already warns about.
 */
export async function findSharedChildIds(
  scope: OwnerScope,
  parentType: ResparkableShareableType,
  parentId: string
): Promise<{ childType: ResparkableShareableType; ids: string[] } | null> {
  switch (parentType) {
    case 'project': {
      const rows = await prisma.resparkableTask.findMany({
        where: { ...ownerWhere(scope), projectId: parentId, archivedAt: null },
        select: { id: true },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
        take: CHILD_PROBE,
      });
      return { childType: 'task', ids: rows.map((row) => row.id) };
    }
    case 'goal': {
      const rows = await prisma.resparkableGoal.findMany({
        where: { ...ownerWhere(scope), parentGoalId: parentId, archivedAt: null },
        select: { id: true },
        orderBy: [{ targetDate: 'asc' }, { createdAt: 'asc' }],
        take: CHILD_PROBE,
      });
      return { childType: 'goal', ids: rows.map((row) => row.id) };
    }
    // area → nothing automatically; review and task have no children; board is
    // resolved by the service. All four are "no children from here".
    default:
      return null;
  }
}

/** The fields every projection shares, so six branches cannot drift on them. */
function base(
  entityType: ResparkableShareableType,
  id: string,
  title: string,
  body: string | null,
  row: { archivedAt: Date | null; updatedAt: Date }
): SharedItemView {
  return {
    entityType,
    id,
    title,
    body,
    status: null,
    dueAt: null,
    horizon: null,
    archived: row.archivedAt !== null,
    updatedAt: row.updatedAt,
    tags: [],
    checklist: null,
  };
}
