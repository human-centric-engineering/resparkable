/**
 * The cascade: which items a grant on one item reaches, and which it does not.
 *
 * ## Computed at read time, never denormalised
 *
 * A grant on a project reaches its tasks because this file says so, not because
 * anything was written onto those tasks. Denormalising would mean every task
 * insert and every task move had to fix up grant rows, and **a missed fix-up is
 * a leak** — a task dragged out of a shared project that keeps its inherited
 * grant is a document still being handed to someone the owner has stopped
 * sharing with, with nothing anywhere saying so.
 *
 * ## Sharing a project DOES include its tasks
 *
 * Read-only, and it is not a convenience. A project without its tasks is a
 * title and a paragraph; people work around that by pasting task lists into
 * descriptions, which is strictly worse — the paste is a snapshot that goes
 * stale, it carries no redaction, and it is invisible to revocation.
 *
 * ## One level and typed, never transitive
 *
 *   project → its tasks
 *   goal    → its child goals
 *   board   → its cards' tasks (explicit membership AND filter membership)
 *   area    → nothing automatically
 *   review  → nothing
 *   task    → nothing
 *
 * **`goal → project` is absent, and this is a deviation from the plan worth
 * naming.** §13 describes the goal cascade as reaching "child goals and
 * projects (and their tasks)". The schema has no goal→project edge: a
 * `ResparkableProject` hangs off an `areaId`, and a goal's relationship to a
 * project is a user-authored `ResparkableLink` row. Following links would make
 * the cascade transitive and user-editable — exactly what "one level and typed"
 * forbids — and inventing an FK to make the sentence true would change the data
 * model to fit a cascade rule. So the goal cascade reaches child goals, and a
 * project is shared by sharing the project. Recorded here rather than quietly
 * diverging.
 *
 * ## The dynamic-filter trap
 *
 * A board with `membership: 'filter'` is a live query, so sharing it shares
 * **every task matching the filter, including ones created later**. That is
 * what people expect from "share my board" and it is also a standing leak: a
 * task created next Tuesday that happens to match becomes visible to that
 * grantee with no further action from the owner.
 *
 * This file implements that faithfully rather than quietly narrowing it, because
 * narrowing would make the board wrong in a way nobody could see. The mitigation
 * is in the share dialog (§13): state the filter in plain English, show a live
 * count, and offer "share a snapshot instead", which flips the board to explicit
 * membership and materialises today's matches.
 */

import {
  findBoardsPinningTasks,
  findFilterBoards,
  findGoalParents,
  findTaskFacts,
  type FilterBoard,
} from '@/lib/framework/resparkable/access/store';
import {
  type ResparkableEntityRef,
  type ResparkableShareableType,
} from '@/lib/framework/resparkable/access/types';
import { boardColumnsSchema, boardFilterSchema } from '@/lib/framework/resparkable/validations';

/**
 * Parent type → the child types a grant on it reaches.
 *
 * Declared as data rather than as branches so the whole cascade is one thing to
 * read, and so a test can assert the shape directly instead of probing for
 * absences one call at a time.
 */
export const RESPARKABLE_CASCADE: Readonly<
  Record<ResparkableShareableType, readonly ResparkableShareableType[]>
> = Object.freeze({
  project: ['task'],
  goal: ['goal'],
  board: ['task'],
  area: [],
  review: [],
  task: [],
});

/** Child type → the parent types that can reach it. The inverse of the above. */
export const RESPARKABLE_CASCADE_PARENTS: Readonly<
  Record<ResparkableShareableType, readonly ResparkableShareableType[]>
> = Object.freeze({
  task: ['project', 'board'],
  goal: ['goal'],
  project: [],
  area: [],
  review: [],
  board: [],
});

/**
 * The refs that could carry a grant reaching these items.
 *
 * One batched pass per parent type, whatever the input size — the point of the
 * plural signature. A per-row version of this function is how sharing a
 * hundred-card board becomes a hundred-query page load, and it is the specific
 * cost §13 accepted when it put `task` back on the shareable list.
 *
 * Returns a map from the child's `type:id` key to its candidate parents. An
 * item with no parents is absent rather than mapped to an empty array — the
 * caller iterates what it finds.
 */
export async function findCascadeParents(
  ownerId: string,
  refs: readonly ResparkableEntityRef[]
): Promise<Map<string, ResparkableEntityRef[]>> {
  const parents = new Map<string, ResparkableEntityRef[]>();
  if (refs.length === 0) return parents;

  const add = (childKey: string, parent: ResparkableEntityRef) => {
    const existing = parents.get(childKey);
    if (existing) existing.push(parent);
    else parents.set(childKey, [parent]);
  };

  const taskIds = refs.filter((ref) => ref.entityType === 'task').map((ref) => ref.entityId);
  const goalIds = refs.filter((ref) => ref.entityType === 'goal').map((ref) => ref.entityId);

  // ── goal → its parent goal, one level ────────────────────────────────────
  //
  // Not walked to the root. A grant on a top-level goal does not reach a
  // grandchild, and that is the "never transitive" rule doing its job: an
  // owner who shares "Health" has said something about Health, not about every
  // goal anyone ever files beneath it, at any depth, for ever.
  if (goalIds.length > 0) {
    const goalParents = await findGoalParents(ownerId, goalIds);
    for (const [goalId, parentGoalId] of goalParents) {
      add(`goal:${goalId}`, { entityType: 'goal', entityId: parentGoalId });
    }
  }

  if (taskIds.length === 0) return parents;

  // ── task → its project, and every board that shows it ────────────────────
  const [facts, pinnedBy, filterBoards] = await Promise.all([
    findTaskFacts(ownerId, taskIds),
    findBoardsPinningTasks(ownerId, taskIds),
    findFilterBoards(ownerId),
  ]);

  for (const taskId of taskIds) {
    const key = `task:${taskId}`;
    const task = facts.get(taskId);
    if (!task) continue;

    if (task.projectId) add(key, { entityType: 'project', entityId: task.projectId });

    for (const boardId of pinnedBy.get(taskId) ?? []) {
      add(key, { entityType: 'board', entityId: boardId });
    }

    for (const board of filterBoards) {
      if (boardFilterMatches(board, task)) {
        add(key, { entityType: 'board', entityId: board.id });
      }
    }
  }

  return parents;
}

/**
 * Does this task appear on this filter-backed board right now?
 *
 * Deliberately the same predicate `loadFilteredCards` uses to build the board
 * (`services/board-view.ts`), reached from the other direction. If the two ever
 * disagree, the disagreement is a leak in exactly one direction — the board
 * shows a card that access resolution says is not shared, or worse, resolution
 * grants a card the board never displayed — so the rules are restated here in
 * full rather than approximated.
 *
 * The `done` rule is the awkward one, and it is the board's own configuration
 * that resolves it: a board with a Done column has asked for finished work by
 * saying where to put it; a board without one would only ever pile finished
 * work into `unplaced`.
 */
export function boardFilterMatches(
  board: FilterBoard,
  task: { projectId: string | null; status: string }
): boolean {
  const parsedFilter = boardFilterSchema.safeParse(board.filter ?? {});

  // **The one place the two directions deliberately DISAGREE.**
  //
  // `loadFilteredCards` falls back to an empty filter when the stored JSON does
  // not parse, so the board renders everything live. Doing the same here would
  // be fail-open in an authorisation path: a corrupt `filter` column would
  // widen a shared board to the owner's whole task list. So this denies
  // instead, and the resulting mismatch runs in the safe direction — the
  // grantee sees fewer cards than the owner does, rather than more.
  //
  // Unreachable through the product: the column is only ever written through
  // `boardFilterSchema`-validated routes. It is reachable by editing the
  // database by hand, which is exactly the situation where "and then it
  // silently shared everything" is the wrong outcome.
  if (!parsedFilter.success) return false;
  const filter = parsedFilter.data;

  if (filter.projectId && filter.projectId !== task.projectId) return false;
  if (filter.includeDone) return true;

  // Abandoned work is not finished work, and no default column shows it.
  if (task.status === 'dropped') return false;

  if (task.status === 'done') {
    // Unparseable columns deny for the same reason: no readable Done column is
    // no evidence the board asked for finished work.
    const parsedColumns = boardColumnsSchema.safeParse(board.columns ?? []);
    if (!parsedColumns.success) return false;
    return parsedColumns.data.some((column) => column.status === 'done');
  }

  return true;
}
