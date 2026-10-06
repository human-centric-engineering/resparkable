/**
 * Unit Tests: titles for the activity feed (phase 59, §23.10).
 *
 * One query per entity type on the page, never one per row, every one scoped
 * to the space.
 *
 * @see lib/framework/resparkable/repo/feed.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { delegate } = vi.hoisted(() => ({
  delegate: () => ({ findMany: vi.fn().mockResolvedValue([]) }),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableTask: delegate(),
    resparkableGoal: delegate(),
    resparkableReview: delegate(),
    resparkableProject: delegate(),
    resparkableArea: delegate(),
    resparkableEntity: delegate(),
    resparkableBoard: delegate(),
    resparkableThought: delegate(),
  },
}));

import { prisma } from '@/lib/db/client';
import { feedRefKey, findFeedTitles } from '@/lib/framework/resparkable/repo/feed';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';

const SCOPE = spaceScopeFor({ spaceId: 'spc_g', actorUserId: 'user_me', role: 'member' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findFeedTitles', () => {
  it('makes one query per type present, scoped to the space, however many rows there are', async () => {
    vi.mocked(prisma.resparkableTask.findMany).mockResolvedValue([
      { id: 't1', title: 'Read chapter 4' },
      { id: 't2', title: 'Book the room' },
    ] as never);

    const titles = await findFeedTitles(SCOPE, [
      { entityType: 'task', entityId: 't1' },
      { entityType: 'task', entityId: 't2' },
      { entityType: 'task', entityId: 't1' },
    ]);

    expect(prisma.resparkableTask.findMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.resparkableTask.findMany).mock.calls[0][0]).toMatchObject({
      where: { spaceId: 'spc_g', id: { in: ['t1', 't2'] } },
    });
    expect(titles.get('task:t1')).toBe('Read chapter 4');
    expect(prisma.resparkableProject.findMany).not.toHaveBeenCalled();
  });

  it('names projects, areas, people and boards by their name', async () => {
    vi.mocked(prisma.resparkableProject.findMany).mockResolvedValue([
      { id: 'p', name: 'Thesis' },
    ] as never);
    vi.mocked(prisma.resparkableArea.findMany).mockResolvedValue([
      { id: 'a', name: 'Study' },
    ] as never);
    vi.mocked(prisma.resparkableEntity.findMany).mockResolvedValue([
      { id: 'e', name: 'Dr Lee' },
    ] as never);
    vi.mocked(prisma.resparkableBoard.findMany).mockResolvedValue([
      { id: 'b', name: 'Term 1' },
    ] as never);
    vi.mocked(prisma.resparkableGoal.findMany).mockResolvedValue([
      { id: 'g', title: 'Pass' },
    ] as never);
    vi.mocked(prisma.resparkableReview.findMany).mockResolvedValue([
      { id: 'r', title: 'Week 3' },
    ] as never);

    const titles = await findFeedTitles(SCOPE, [
      { entityType: 'project', entityId: 'p' },
      { entityType: 'area', entityId: 'a' },
      { entityType: 'entity', entityId: 'e' },
      { entityType: 'board', entityId: 'b' },
      { entityType: 'goal', entityId: 'g' },
      { entityType: 'review', entityId: 'r' },
    ]);

    expect([...titles.values()]).toEqual(
      expect.arrayContaining(['Thesis', 'Study', 'Dr Lee', 'Term 1', 'Pass', 'Week 3'])
    );
  });

  it('names a note by its opening words, cut at eighty characters', async () => {
    vi.mocked(prisma.resparkableThought.findMany).mockResolvedValue([
      { id: 'short', content: 'Ask about the reading list\nand more below' },
      { id: 'long', content: 'x'.repeat(120) },
    ] as never);

    const titles = await findFeedTitles(SCOPE, [
      { entityType: 'thought', entityId: 'short' },
      { entityType: 'thought', entityId: 'long' },
    ]);

    expect(titles.get('thought:short')).toBe('Ask about the reading list');
    expect(titles.get('thought:long')).toBe(`${'x'.repeat(79)}…`);
  });

  it('asks nothing for a type it has no title for, and leaves a deleted item out', async () => {
    vi.mocked(prisma.resparkableTask.findMany).mockResolvedValue([]);

    const titles = await findFeedTitles(SCOPE, [
      { entityType: 'timeBlock', entityId: 'tb' },
      { entityType: 'task', entityId: 'gone' },
    ]);

    expect(titles.size).toBe(0);
  });
});

describe('feedRefKey', () => {
  it('keys a reference by type and id', () => {
    expect(feedRefKey({ entityType: 'task', entityId: 't1' })).toBe('task:t1');
  });
});
