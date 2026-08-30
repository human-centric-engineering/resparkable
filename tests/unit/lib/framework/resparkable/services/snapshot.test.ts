/**
 * Unit Tests: `buildSnapshot`.
 *
 * The snapshot is what an agent is told about a brain before it says anything,
 * so its failure modes are all "the model confidently repeats something false".
 * Two of them are load-bearing:
 *
 *   1. **A section that stopped at its cap must say so.** Otherwise a brain with
 *      400 projects looks like a brain with 12, and the agent plans around the
 *      12 it can see. Same rule as the sweep's `cappedTypes` (`ui.md` §7).
 *   2. **The query count does not move with the row count.** This payload feeds
 *      the context block injected on *every* chat turn, so an N+1 here is the
 *      most expensive N+1 in the product.
 *
 * Test Coverage:
 * - Exactly seven queries, whatever the row counts are
 * - `truncated` is set per section when the cap was hit, and only then —
 *   including `topTasks`, which asserted `false` unconditionally
 * - Every repo call is scoped — the isolation contract (D5)
 *
 * @see lib/framework/resparkable/services/snapshot.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/areas', () => ({ listAreas: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/goals', () => ({ listGoals: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ listProjects: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/reviews', () => ({ findLatestReview: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/tasks', () => ({ listTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/counts', () => ({ buildCounts: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/space', () => ({ getResparkableSettings: vi.fn() }));

import { buildSnapshot } from '@/lib/framework/resparkable/services/snapshot';
import { listAreas } from '@/lib/framework/resparkable/repo/areas';
import { listGoals } from '@/lib/framework/resparkable/repo/goals';
import { listProjects } from '@/lib/framework/resparkable/repo/projects';
import { findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { buildCounts } from '@/lib/framework/resparkable/services/counts';
import { getResparkableSettings } from '@/lib/framework/resparkable/services/space';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import type {
  ResparkableArea,
  ResparkableGoal,
  ResparkableProject,
  ResparkableTask,
} from '@prisma/client';

const mockedAreas = vi.mocked(listAreas);
const mockedGoals = vi.mocked(listGoals);
const mockedProjects = vi.mocked(listProjects);
const mockedReview = vi.mocked(findLatestReview);
const mockedTasks = vi.mocked(listTasks);
const mockedCounts = vi.mocked(buildCounts);
const mockedSettings = vi.mocked(getResparkableSettings);

const SCOPE = spaceScope('user_a');
const NOW = new Date('2026-07-30T12:00:00.000Z');

function area(id: string): ResparkableArea {
  return { id, name: `Area ${id}` } as ResparkableArea;
}

function task(id: string): ResparkableTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    dueAt: null,
    estimateMinutes: null,
    projectId: null,
    priorityScore: 0.5,
    priorityFactors: null,
  } as unknown as ResparkableTask;
}

/** Every repo/service the snapshot is allowed to read: seven calls across seven mocks. */
const ALL_MOCKS = [
  mockedAreas,
  mockedGoals,
  mockedProjects,
  mockedReview,
  mockedTasks,
  mockedCounts,
  mockedSettings,
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue({
    timezone: 'UTC',
    workStyle: 'balanced',
  } as Awaited<ReturnType<typeof getResparkableSettings>>);
  mockedCounts.mockResolvedValue({ inbox: 4, connections: 2, openTasks: 9 });
  mockedGoals.mockResolvedValue([]);
  mockedProjects.mockResolvedValue([]);
  mockedTasks.mockResolvedValue([]);
  mockedAreas.mockResolvedValue([]);
  mockedReview.mockResolvedValue(null);
});

describe('buildSnapshot query cost', () => {
  it('issues exactly seven reads on an empty brain', async () => {
    await buildSnapshot(SCOPE, NOW);

    const total = ALL_MOCKS.reduce((sum, mock) => sum + mock.mock.calls.length, 0);
    expect(total).toBe(7);
  });

  it('issues the same seven reads however many rows exist', async () => {
    mockedGoals.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `g${i}`, title: 't' }) as ResparkableGoal)
    );
    mockedProjects.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: 'n' }) as ResparkableProject)
    );
    mockedAreas.mockResolvedValue(Array.from({ length: 200 }, (_, i) => area(`a${i}`)));

    // The number that must not move with the row count — this payload is built
    // on every chat turn.
    await buildSnapshot(SCOPE, NOW);

    const total = ALL_MOCKS.reduce((sum, mock) => sum + mock.mock.calls.length, 0);
    expect(total).toBe(7);
  });

  it('scopes every read', async () => {
    await buildSnapshot(SCOPE, NOW);

    expect(mockedGoals.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedProjects.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedTasks.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedAreas.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedReview.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedSettings).toHaveBeenCalledWith('user_a');
  });
});

describe('buildSnapshot truncation', () => {
  it('does not claim truncation when a section fitted', async () => {
    mockedGoals.mockResolvedValue([{ id: 'g1', title: 'Ship it' } as ResparkableGoal]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.goals.truncated).toBe(false);
    expect(snapshot.goals.items).toHaveLength(1);
  });

  it('flags truncation and trims to the cap when there were more rows', async () => {
    // The service asks for `limit + 1` precisely so this is answerable without a
    // second counting query.
    mockedGoals.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, title: 't' }) as ResparkableGoal)
    );

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.goals.truncated).toBe(true);
    expect(snapshot.goals.items).toHaveLength(24);
  });

  it('flags truncation on topTasks — it was hardcoded false', async () => {
    // A payload claiming the five tasks shown are all of them, while
    // `counts.openTasks` in the same object says forty, is worse than either
    // answer alone: an LLM reading both gets a contradiction.
    mockedTasks.mockResolvedValue(Array.from({ length: 6 }, (_, i) => task(`t${i}`)));

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items).toHaveLength(5);
    expect(snapshot.topTasks.truncated).toBe(true);
  });

  it('does not flag topTasks when the brain really has five or fewer', async () => {
    mockedTasks.mockResolvedValue(Array.from({ length: 3 }, (_, i) => task(`t${i}`)));

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items).toHaveLength(3);
    expect(snapshot.topTasks.truncated).toBe(false);
  });

  it('flags truncation on areas when there were more rows than the cap', async () => {
    mockedAreas.mockResolvedValue(Array.from({ length: 20 }, (_, i) => area(`a${i}`)));

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.areas.items).toHaveLength(12);
    expect(snapshot.areas.truncated).toBe(true);
  });
});

describe('buildSnapshot areas', () => {
  it('renders an area as just its id and name', async () => {
    mockedAreas.mockResolvedValue([area('a1')]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.areas.items[0]).toEqual({ id: 'a1', name: 'Area a1' });
  });
});

describe('buildSnapshot shape', () => {
  it('serialises dates as strings so the payload survives JSON transport', async () => {
    mockedTasks.mockResolvedValue([
      {
        id: 't1',
        title: 'Ring the accountant',
        status: 'todo',
        dueAt: new Date('2026-08-01T09:00:00.000Z'),
        estimateMinutes: 30,
        projectId: null,
        priorityScore: 0.8,
        priorityFactors: { dominantFactor: 'urgency' },
      } as unknown as ResparkableTask,
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items[0]?.dueAt).toBe('2026-08-01T09:00:00.000Z');
    expect(snapshot.topTasks.items[0]?.dominantFactor).toBe('urgency');
  });

  it('reads a dominant factor of an unexpected shape as null rather than throwing', async () => {
    mockedTasks.mockResolvedValue([
      {
        id: 't1',
        title: 'x',
        status: 'todo',
        dueAt: null,
        estimateMinutes: null,
        projectId: null,
        priorityScore: 0,
        priorityFactors: 'not-an-object',
      } as unknown as ResparkableTask,
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items[0]?.dominantFactor).toBeNull();
  });

  it('computes the ISO week from the user’s own wall clock', async () => {
    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.today.date).toBe('2026-07-30');
    expect(snapshot.today.isoWeek).toBe(31);
  });
});
