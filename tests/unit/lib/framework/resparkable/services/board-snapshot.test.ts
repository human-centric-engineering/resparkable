/**
 * Unit Tests: the dynamic-filter mitigations (Release 2, phase 12).
 *
 * §13 names a leak it deliberately accepts and then requires three mitigations
 * for it: a board with `membership: 'filter'` is a live query, so sharing it
 * shares **every task matching the filter, including ones created next
 * Tuesday**, with no further gesture from the owner. That is what people expect
 * from "share my board", and it is also a standing leak.
 *
 * Two of the three are asserted here — the third, the live count, is
 * `totalCards`, which `board-view.test.ts` already covers.
 *
 *   1. **The rule, in plain English** (`describeBoardFilter`). Pure, so the
 *      exact wording can be held to. It has to end by naming the consequence
 *      rather than the criteria: a summary that stopped at "tasks in Acme" would
 *      be accurate and useless.
 *   2. **The snapshot** (`snapshotBoard`). It must freeze exactly what the owner
 *      was looking at, in the order they were looking at it, and it must refuse
 *      a board that is already explicit — re-pinning a board somebody curated by
 *      hand would throw their arrangement away.
 *
 * @see lib/framework/resparkable/services/board-view.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/boards', () => ({
  findBoard: vi.fn(),
  listBoardCards: vi.fn(),
  snapshotBoardMembership: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/tasks', () => ({
  listTasks: vi.fn(),
  findTasksByIds: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/tags', () => ({ listTagsForTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/checklist', () => ({ listChecklistForTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/events', () => ({ findLatestStatusChanges: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ findProject: vi.fn() }));

import {
  buildBoardView,
  describeBoardFilter,
  snapshotBoard,
} from '@/lib/framework/resparkable/services/board-view';
import {
  findBoard,
  listBoardCards,
  snapshotBoardMembership,
} from '@/lib/framework/resparkable/repo/boards';
import { listChecklistForTasks } from '@/lib/framework/resparkable/repo/checklist';
import { findLatestStatusChanges } from '@/lib/framework/resparkable/repo/events';
import { findProject } from '@/lib/framework/resparkable/repo/projects';
import { listTagsForTasks } from '@/lib/framework/resparkable/repo/tags';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const OWNER = ownerScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');
const PROJECT_ID = 'clh0000000000000000000001';

const COLUMNS = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
];

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: 'board_1',
    userId: 'user_a',
    name: 'Roadmap',
    slug: 'roadmap',
    description: null,
    columns: COLUMNS,
    membership: 'filter',
    filter: null,
    swimlaneBy: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function task(id: string, status: string) {
  return {
    id,
    userId: 'user_a',
    title: id,
    status,
    priorityScore: 1,
    updatedAt: NOW,
    createdAt: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTagsForTasks).mockResolvedValue([] as never);
  vi.mocked(listChecklistForTasks).mockResolvedValue([] as never);
  vi.mocked(findLatestStatusChanges).mockResolvedValue(new Map() as never);
  vi.mocked(listBoardCards).mockResolvedValue([] as never);
  vi.mocked(findProject).mockResolvedValue(null);
});

describe('describeBoardFilter', () => {
  it('always ends by naming the consequence, not the criteria', () => {
    const summary = describeBoardFilter({}, null, ['todo']);

    // The sentence a person has to have read before they agree to share.
    expect(summary).toContain('tasks you add later');
  });

  it('names the project when it resolves', () => {
    expect(describeBoardFilter({ projectId: PROJECT_ID }, 'Acme Redesign', ['todo'])).toContain(
      'Acme Redesign'
    );
  });

  it('never puts a raw id in front of a person', () => {
    const summary = describeBoardFilter({ projectId: PROJECT_ID }, null, ['todo']);

    // A deleted project should degrade to an honest "one project", not to an
    // id that tells the reader nothing and looks like a bug.
    expect(summary).not.toContain(PROJECT_ID);
    expect(summary).toContain('one project');
  });

  it('says finished work is excluded only when it actually is', () => {
    // No Done column and `includeDone` unset: finished work is filtered out.
    expect(describeBoardFilter({}, null, ['todo'])).toContain('not finished');

    // A board with a Done column has asked for finished work by saying where
    // it goes, so claiming otherwise would be a false statement about a share.
    expect(describeBoardFilter({}, null, ['todo', 'done'])).not.toContain('not finished');
    expect(describeBoardFilter({ includeDone: true }, null, ['todo'])).not.toContain(
      'not finished'
    );
  });

  it('describes an unreadable filter exactly as the render path treats it', () => {
    // `loadFilteredCards` falls back to an empty filter rather than failing, so
    // the sentence has to describe *that* board — the one the grantee will
    // actually see — not the criteria nobody could parse. An empty filter still
    // excludes finished work on a board with no Done column, so the summary
    // says so, and it claims no project narrowing that is not being applied.
    const summary = describeBoardFilter({ nonsense: true }, 'Acme Redesign', ['todo']);

    expect(summary).toContain('not finished');
    expect(summary).not.toContain('Acme Redesign');
  });

  it('says "every task" when nothing narrows the board at all', () => {
    // A Done column plus no project: the board really is every task in the
    // brain, and the share dialog has to say the widest true thing.
    expect(describeBoardFilter({}, null, ['todo', 'done'])).toContain('every task');
  });
});

describe('buildBoardView filterSummary', () => {
  it('is null on an explicit board, which has nothing to warn about', async () => {
    vi.mocked(findBoard).mockResolvedValue(board({ membership: 'explicit' }) as never);

    const view = await buildBoardView(OWNER, 'board_1', NOW);

    expect(view?.filterSummary).toBeNull();
    // No project lookup either: an explicit board's filter is not read at all.
    expect(findProject).not.toHaveBeenCalled();
  });

  it('is present on a filter board, and spends one lookup on the project name', async () => {
    vi.mocked(findBoard).mockResolvedValue(board({ filter: { projectId: PROJECT_ID } }) as never);
    vi.mocked(findProject).mockResolvedValue({ name: 'Acme Redesign' } as never);
    vi.mocked(listTasks).mockResolvedValue([task('t_1', 'todo')] as never);

    const view = await buildBoardView(OWNER, 'board_1', NOW);

    expect(view?.filterSummary).toContain('Acme Redesign');
    expect(findProject).toHaveBeenCalledTimes(1);
  });

  it('spends no lookup when the filter names no project', async () => {
    vi.mocked(findBoard).mockResolvedValue(board() as never);
    vi.mocked(listTasks).mockResolvedValue([] as never);

    await buildBoardView(OWNER, 'board_1', NOW);

    expect(findProject).not.toHaveBeenCalled();
  });
});

describe('snapshotBoard', () => {
  it('refuses a board that is already explicit', async () => {
    vi.mocked(findBoard).mockResolvedValue(board({ membership: 'explicit' }) as never);

    expect(await snapshotBoard(OWNER, 'board_1', NOW)).toBeNull();
    // Re-pinning a hand-curated board from a filter that no longer describes it
    // would throw the owner's arrangement away.
    expect(snapshotBoardMembership).not.toHaveBeenCalled();
  });

  it('refuses a board that is not this owner’s', async () => {
    vi.mocked(findBoard).mockResolvedValue(null);

    expect(await snapshotBoard(OWNER, 'board_1', NOW)).toBeNull();
    expect(snapshotBoardMembership).not.toHaveBeenCalled();
  });

  it('pins exactly what the board shows, in the order it shows it', async () => {
    vi.mocked(findBoard).mockResolvedValue(board() as never);
    vi.mocked(listTasks).mockResolvedValue([
      task('t_doing', 'doing'),
      task('t_todo', 'todo'),
      task('t_orphan', 'waiting'),
    ] as never);
    vi.mocked(snapshotBoardMembership).mockResolvedValue(
      board({ membership: 'explicit' }) as never
    );

    await snapshotBoard(OWNER, 'board_1', NOW);

    const cards = vi.mocked(snapshotBoardMembership).mock.calls[0][2];
    // Column order first, then anything unplaced last. A card whose status has
    // no column is still on the board, and dropping it would make the snapshot
    // disagree with what the owner was looking at.
    expect(cards.map((card) => card.taskId)).toEqual(['t_todo', 't_doing', 't_orphan']);
    // Whole steps apart, so the first drag afterwards lands between two cards
    // without needing a renormalisation pass.
    expect(cards.map((card) => card.position)).toEqual([1000, 2000, 3000]);
  });

  it('reads the board back rather than relabelling the filter view', async () => {
    vi.mocked(findBoard)
      .mockResolvedValueOnce(board() as never)
      .mockResolvedValueOnce(board({ membership: 'explicit' }) as never);
    vi.mocked(listTasks).mockResolvedValue([task('t_1', 'todo')] as never);
    vi.mocked(snapshotBoardMembership).mockResolvedValue(
      board({ membership: 'explicit' }) as never
    );

    const view = await snapshotBoard(OWNER, 'board_1', NOW);

    // The board is explicit now, which is a different load path with different
    // ordering. Returning the filter view relabelled would show the caller a
    // board that no longer exists.
    expect(view?.board.membership).toBe('explicit');
    expect(view?.filterSummary).toBeNull();
    expect(listBoardCards).toHaveBeenCalled();
  });
});
