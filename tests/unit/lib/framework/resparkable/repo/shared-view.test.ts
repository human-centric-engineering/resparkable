/**
 * Unit Tests: the shared-reader projection (Release 2, phase 11).
 *
 * **This file is the reason the projection is an allowlist.** Everywhere else
 * in the tier the rule is `omit`, not `select` — a column added tomorrow should
 * be exported by default rather than silently dropped. Here it is inverted: a
 * column added to `ResparkableTask` next month must NOT appear on a public page
 * because nobody remembered to exclude it.
 *
 * An allowlist is only worth anything if something checks it, and the check
 * cannot be "read the file" — the whole failure mode is a field arriving that
 * nobody looked at. So these tests assert the **`select` objects handed to
 * Prisma**, against a list of forbidden columns, rather than the returned
 * shape: a value that is never fetched cannot be leaked by a serialiser
 * downstream, and one that IS fetched can be, by any of them.
 *
 * Test Coverage:
 * - No projection selects a score, a boost rationale, or scheduling state
 * - Every projection is owner-scoped
 * - A task's `notes` is fetched but withheld unless `includeTaskDetail`
 * - A board's `filter` and a review's `payload` are never fetched at all
 * - Children are ordered by due date, never by rank
 * - The child list is capped, and the cap is stated
 *
 * @see lib/framework/resparkable/repo/shared-view.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: Object.fromEntries(
    [
      'resparkableArea',
      'resparkableGoal',
      'resparkableProject',
      'resparkableReview',
      'resparkableBoard',
      'resparkableTask',
      'resparkableBoardCard',
    ].map((model) => [model, { findMany: vi.fn().mockResolvedValue([]) }])
  ),
}));

import { prisma } from '@/lib/db/client';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  findSharedChildIds,
  findSharedItem,
  findSharedItems,
  SHARED_CHILD_LIMIT,
} from '@/lib/framework/resparkable/repo/shared-view';
import {
  RESPARKABLE_SHAREABLE_TYPES,
  type ResparkableShareableType,
} from '@/lib/framework/resparkable/access/types';

const SCOPE = spaceScope('user_a');

const delegates = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;

const DELEGATE_FOR: Record<string, string> = {
  area: 'resparkableArea',
  goal: 'resparkableGoal',
  project: 'resparkableProject',
  review: 'resparkableReview',
  board: 'resparkableBoard',
  task: 'resparkableTask',
};

/**
 * Columns that must never be fetched for a shared reader.
 *
 * Each is either the owner's private opinion of their own work (a score, a
 * boost rationale), their scheduling state (snooze, defer, energy), or metadata
 * about how they organise (a board's filter, a slug, a foreign key). A reader
 * holding a link is entitled to the item; none of this is the item.
 */
const FORBIDDEN = [
  'priorityScore',
  'priorityFactors',
  'manualBoost',
  'manualBoostExpiresAt',
  'manualBoostReason',
  'snoozeCount',
  'snoozedUntil',
  'lastSnoozedAt',
  'deferUntil',
  'energy',
  'estimateMinutes',
  'contextTag',
  'lastActivityAt',
  'slug',
  'rev',
  'indexedHash',
  'visibility',
  'userId',
  'projectId',
  'areaId',
  'parentGoalId',
  'filter',
  'payload',
  'columns',
  'membership',
  'workflowExecutionId',
  'searchVector',
  'archivedReason',
];

/** The `select` handed to a delegate's most recent `findMany`. */
function lastSelect(model: string): Record<string, unknown> {
  const calls = delegates[model].findMany.mock.calls;
  return (calls[calls.length - 1]?.[0] as { select: Record<string, unknown> }).select;
}

function lastWhere(model: string): Record<string, unknown> {
  const calls = delegates[model].findMany.mock.calls;
  return (calls[calls.length - 1]?.[0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const delegate of Object.values(delegates)) delegate.findMany.mockResolvedValue([]);
});

describe('the projection is an allowlist', () => {
  it('fetches no forbidden column, for any shareable type', async () => {
    // A sweep rather than a case per type, for the same reason
    // `capabilities/scope.test.ts` sweeps: the failure this guards is not
    // "someone wrote a projection wrong", it is "someone added a seventh type
    // and copied the wrong select", and no per-type test catches the test
    // nobody wrote.
    for (const entityType of RESPARKABLE_SHAREABLE_TYPES) {
      await findSharedItems(SCOPE, entityType, ['x_1'], true);

      const select = lastSelect(DELEGATE_FOR[entityType]);
      for (const column of FORBIDDEN) {
        expect(select, `${entityType} selects ${column}`).not.toHaveProperty(column);
      }
    }
  });

  it('scopes every projection to the owner', async () => {
    for (const entityType of RESPARKABLE_SHAREABLE_TYPES) {
      await findSharedItems(SCOPE, entityType, ['x_1'], false);
      expect(lastWhere(DELEGATE_FOR[entityType])).toMatchObject({ spaceId: 'user_a' });
    }
  });

  it('makes no query at all for an empty id list', async () => {
    await findSharedItems(SCOPE, 'task', [], false);
    expect(delegates.resparkableTask.findMany).not.toHaveBeenCalled();
  });

  it('throws rather than silently returning nothing for an unrecognised type', async () => {
    // The `never` arm makes a seventh shareable type without a projection a
    // compile error elsewhere; here it must fail loudly, not resolve to `[]`,
    // which would read as "this owner has nothing" rather than "this is a bug".
    await expect(
      findSharedItems(
        SCOPE,
        'not-a-real-type' as unknown as ResparkableShareableType,
        ['x_1'],
        false
      )
    ).rejects.toThrow(/no projection for/);
  });
});

describe('task detail', () => {
  it('withholds notes unless asked, and never withholds the title', async () => {
    delegates.resparkableTask.findMany.mockResolvedValue([
      {
        id: 't_1',
        title: 'Call the accountant',
        notes: 'about the thing I do not want a stranger reading',
        status: 'todo',
        dueAt: null,
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        tags: [],
        checklist: [],
      },
    ]);

    const [withheld] = await findSharedItems(SCOPE, 'task', ['t_1'], false);
    const [shown] = await findSharedItems(SCOPE, 'task', ['t_1'], true);

    expect(withheld.body).toBeNull();
    expect(withheld.title).toBe('Call the accountant');
    expect(shown.body).toContain('stranger');
  });

  it('reports checklist progress, never the item text', async () => {
    // "3 of 7" says how far along the work is. The item text is working
    // commentary, the same kind of thing `notes` is.
    delegates.resparkableTask.findMany.mockResolvedValue([
      {
        id: 't_1',
        title: 'Ship it',
        notes: null,
        status: 'doing',
        dueAt: null,
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        tags: [{ tag: { name: 'urgent' } }],
        checklist: [{ isDone: true }, { isDone: false }, { isDone: true }],
      },
    ]);

    const [task] = await findSharedItems(SCOPE, 'task', ['t_1'], true);

    expect(task.checklist).toEqual({ done: 2, total: 3 });
    expect(task.tags).toEqual(['urgent']);
    expect(lastSelect('resparkableTask').checklist).toEqual({ select: { isDone: true } });
  });

  it('reports no checklist rather than an empty one when there are no items', async () => {
    // So the UI can tell "nothing to do" from "no checklist here".
    delegates.resparkableTask.findMany.mockResolvedValue([
      {
        id: 't_1',
        title: 'Ship it',
        notes: null,
        status: 'doing',
        dueAt: null,
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        tags: [],
        checklist: [],
      },
    ]);

    const [task] = await findSharedItems(SCOPE, 'task', ['t_1'], true);
    expect(task.checklist).toBeNull();
  });

  it('marks an archived item as archived rather than hiding it', async () => {
    // An archived item with a live link still resolves: the owner retired the
    // thinking, they did not revoke the link. The reader deserves to know.
    delegates.resparkableProject.findMany.mockResolvedValue([
      {
        id: 'p_1',
        name: 'Old rebrand',
        description: null,
        status: 'abandoned',
        archivedAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const [project] = await findSharedItems(SCOPE, 'project', ['p_1'], false);
    expect(project.archived).toBe(true);
  });
});

describe('children', () => {
  it('orders a project’s tasks by due date, never by rank', async () => {
    // Ordering by `priorityScore` would leak the owner's ranking through the
    // sequence even with the number itself withheld.
    await findSharedChildIds(SCOPE, 'project', 'p_1');

    const [args] = delegates.resparkableTask.findMany.mock.calls[0] as [
      { orderBy: unknown; take: number; where: Record<string, unknown> },
    ];

    expect(args.orderBy).toEqual([{ dueAt: 'asc' }, { createdAt: 'asc' }]);
    // One MORE than the share renders, deliberately. The extra row is never
    // shown; it exists so the service can tell a list that happens to be
    // exactly the limit from one that was cut at it. Asserting equality with
    // the limit here is what let "Showing the first 200. There are more."
    // render for a project with exactly 200 tasks and no more.
    expect(args.take).toBe(SHARED_CHILD_LIMIT + 1);
    // Archived children are not listed: the parent is shared, the retired work
    // beneath it is not part of what was handed over.
    expect(args.where).toMatchObject({ spaceId: 'user_a', projectId: 'p_1', archivedAt: null });
  });

  it('reaches a goal’s child goals', async () => {
    const children = await findSharedChildIds(SCOPE, 'goal', 'g_1');
    expect(children?.childType).toBe('goal');
    expect(lastWhere('resparkableGoal')).toMatchObject({ parentGoalId: 'g_1' });
  });

  it('returns nothing for the types that cascade to nothing', async () => {
    // area → nothing automatically; review and task have no children; a board
    // is resolved by the service, because a filter-backed board is a live query
    // owned by `board-view.ts`.
    for (const parentType of ['area', 'review', 'task', 'board'] as const) {
      await expect(findSharedChildIds(SCOPE, parentType, 'x_1')).resolves.toBeNull();
    }
    expect(delegates.resparkableBoardCard.findMany).not.toHaveBeenCalled();
  });
});

describe('findSharedItem (singular)', () => {
  it('returns the one item the batched form found', async () => {
    delegates.resparkableProject.findMany.mockResolvedValue([
      {
        id: 'p_1',
        name: 'Acme Redesign',
        description: 'A rebrand',
        status: 'active',
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    const item = await findSharedItem(SCOPE, 'project', 'p_1', false);

    expect(item?.id).toBe('p_1');
    expect(item?.title).toBe('Acme Redesign');
  });

  it('returns null rather than undefined when nothing matches', async () => {
    delegates.resparkableProject.findMany.mockResolvedValue([]);
    await expect(findSharedItem(SCOPE, 'project', 'p_1', false)).resolves.toBeNull();
  });
});

describe('per-type field mapping', () => {
  it('goal: status is carried, and dueAt comes from targetDate rather than a separate column', async () => {
    // A goal's target date IS its due date: same field, same column. Getting
    // this wrong either drops the date entirely or invents a second one.
    delegates.resparkableGoal.findMany.mockResolvedValue([
      {
        id: 'g_1',
        title: 'Learn to sail',
        description: 'Get comfortable single-handing',
        horizon: 'quarter',
        status: 'active',
        targetDate: new Date('2026-12-01T00:00:00Z'),
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    const [goal] = await findSharedItems(SCOPE, 'goal', ['g_1'], false);

    expect(goal.status).toBe('active');
    expect(goal.horizon).toBe('quarter');
    expect(goal.dueAt).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('project: status is carried, horizon and dueAt stay null, having neither', async () => {
    delegates.resparkableProject.findMany.mockResolvedValue([
      {
        id: 'p_1',
        name: 'Acme Redesign',
        description: 'A rebrand',
        status: 'active',
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    const [project] = await findSharedItems(SCOPE, 'project', ['p_1'], false);

    expect(project.status).toBe('active');
    expect(project.horizon).toBeNull();
    expect(project.dueAt).toBeNull();
  });

  it('review: horizon is carried, and body comes from the review body column', async () => {
    delegates.resparkableReview.findMany.mockResolvedValue([
      {
        id: 'r_1',
        title: 'Weekly review',
        body: 'This week went well',
        horizon: 'week',
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    const [review] = await findSharedItems(SCOPE, 'review', ['r_1'], false);

    expect(review.horizon).toBe('week');
    expect(review.body).toBe('This week went well');
    // A review has no status of its own on this projection.
    expect(review.status).toBeNull();
  });

  it('area and board: only the shared base fields, no status/horizon/dueAt of their own', async () => {
    delegates.resparkableArea.findMany.mockResolvedValue([
      {
        id: 'a_1',
        name: 'Health',
        description: 'Fitness and wellbeing',
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);
    delegates.resparkableBoard.findMany.mockResolvedValue([
      {
        id: 'b_1',
        name: 'Sprint board',
        description: null,
        archivedAt: null,
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);

    const [area] = await findSharedItems(SCOPE, 'area', ['a_1'], false);
    const [board] = await findSharedItems(SCOPE, 'board', ['b_1'], false);

    for (const item of [area, board]) {
      expect(item.status).toBeNull();
      expect(item.horizon).toBeNull();
      expect(item.dueAt).toBeNull();
    }
    expect(area.title).toBe('Health');
    expect(board.title).toBe('Sprint board');
  });
});

describe('includeTaskDetail gates a task’s prose only: every other type shows its body regardless', () => {
  // `withDetail` is called `includeTaskDetail`, not `includeBody`, precisely
  // because a task's `notes` is private working commentary beside a one-line
  // title, whereas every other type's body IS the item, and withholding it would
  // leave a title and nothing else. This sweep proves the flag has no effect
  // outside the task branch.
  const NON_TASK_ROWS: Record<
    Exclude<ResparkableShareableType, 'task'>,
    Record<string, unknown>
  > = {
    area: {
      id: 'x_1',
      name: 'Area',
      description: 'the body text',
      archivedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    goal: {
      id: 'x_1',
      title: 'Goal',
      description: 'the body text',
      horizon: 'week',
      status: 'active',
      targetDate: null,
      archivedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    project: {
      id: 'x_1',
      name: 'Project',
      description: 'the body text',
      status: 'active',
      archivedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    review: {
      id: 'x_1',
      title: 'Review',
      body: 'the body text',
      horizon: 'week',
      archivedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    board: {
      id: 'x_1',
      name: 'Board',
      description: 'the body text',
      archivedAt: null,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    },
  };

  it.each(Object.entries(NON_TASK_ROWS))(
    '%s: body is shown even when withDetail is false',
    async (entityType, row) => {
      delegates[DELEGATE_FOR[entityType]].findMany.mockResolvedValue([row]);

      const [item] = await findSharedItems(
        SCOPE,
        entityType as ResparkableShareableType,
        ['x_1'],
        false
      );

      expect(item.body).toBe('the body text');
    }
  );
});
