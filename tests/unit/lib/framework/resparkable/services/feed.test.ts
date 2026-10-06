/**
 * Unit Tests: building the group activity feed (phase 59, §23.10).
 *
 * Includes 13l's data half: what the feed reads does not depend on what the
 * reader has seen. `feedSeenAt` styles lines; it never shapes a query.
 *
 * @see lib/framework/resparkable/services/feed.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findAccountNames: vi.fn(),
  findGroupBySpaceId: vi.fn(),
  findMembershipBySpace: vi.fn(),
  setFeedSeenAt: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/events', () => ({ listEvents: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/repo/feed')>()),
  findFeedTitles: vi.fn(),
}));

import { listEvents } from '@/lib/framework/resparkable/repo/events';
import { findFeedTitles } from '@/lib/framework/resparkable/repo/feed';
import {
  findAccountNames,
  findGroupBySpaceId,
  findMembershipBySpace,
  setFeedSeenAt,
} from '@/lib/framework/resparkable/repo/groups';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import { buildFeed, FEED_PAGE_SIZE, markFeedSeen } from '@/lib/framework/resparkable/services/feed';

const SCOPE = spaceScopeFor({ spaceId: 'spc_g', actorUserId: 'user_me', role: 'member' });
const GROUP = { id: 'grp_1', spaceId: 'spc_g' };

function event(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_${n}`,
    spaceId: 'spc_g',
    createdByUserId: 'user_sam',
    kind: 'created',
    entityType: 'task',
    entityId: `task_${n}`,
    metadata: null,
    source: 'user',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) - n * 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findGroupBySpaceId).mockResolvedValue(GROUP as never);
  vi.mocked(findFeedTitles).mockResolvedValue(new Map([['task:task_1', 'Chapter 4 notes']]));
  vi.mocked(findAccountNames).mockResolvedValue(new Map([['user_sam', 'Sam']]));
  vi.mocked(findMembershipBySpace).mockResolvedValue({ feedSeenAt: null } as never);
  vi.mocked(listEvents).mockResolvedValue([event(1)] as never);
});

describe('buildFeed', () => {
  it('returns nothing for a personal workspace', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue(null);

    expect(await buildFeed(SCOPE)).toBeNull();
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('reads one page plus one, to know whether there is more', async () => {
    await buildFeed(SCOPE);

    expect(vi.mocked(listEvents).mock.calls[0][2]).toEqual({ take: FEED_PAGE_SIZE + 1 });
  });

  it('maps titles, names and attribution onto each line', async () => {
    vi.mocked(listEvents).mockResolvedValue([
      event(1),
      event(2, { createdByUserId: 'user_me' }),
      event(3, { createdByUserId: null, source: 'system' }),
    ] as never);

    const page = await buildFeed(SCOPE);

    expect(
      page?.items.map(({ title, actorName, byYou, system }) => ({
        title,
        actorName,
        byYou,
        system,
      }))
    ).toEqual([
      { title: 'Chapter 4 notes', actorName: 'Sam', byYou: false, system: false },
      { title: null, actorName: null, byYou: true, system: false },
      { title: null, actorName: null, byYou: false, system: true },
    ]);
  });

  it('gives a cursor only when there is another page', async () => {
    expect((await buildFeed(SCOPE))?.nextCursor).toBeNull();

    const full = Array.from({ length: FEED_PAGE_SIZE + 1 }, (_, n) => event(n + 1));
    vi.mocked(listEvents).mockResolvedValue(full);
    const page = await buildFeed(SCOPE);

    expect(page?.items).toHaveLength(FEED_PAGE_SIZE);
    expect(page?.nextCursor).toBe(full[FEED_PAGE_SIZE - 1].createdAt.toISOString());
  });

  it('passes the cursor and the member filter through as rows-only filters', async () => {
    const before = new Date('2026-09-30T00:00:00.000Z');

    await buildFeed(SCOPE, { before, memberUserId: 'user_sam' });

    expect(vi.mocked(listEvents).mock.calls[0][1]).toEqual({ before, actorUserId: 'user_sam' });
  });

  it('returns when the reader last looked', async () => {
    const seen = new Date('2026-09-29T00:00:00.000Z');
    vi.mocked(findMembershipBySpace).mockResolvedValue({ feedSeenAt: seen } as never);

    expect((await buildFeed(SCOPE))?.seenAt).toEqual(seen);
  });

  it('13l: reads exactly the same rows for a reader who has seen everything and one who has seen nothing', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValueOnce({ feedSeenAt: null } as never);
    await buildFeed(SCOPE);
    vi.mocked(findMembershipBySpace).mockResolvedValueOnce({
      feedSeenAt: new Date('2026-10-05T00:00:00.000Z'),
    } as never);
    await buildFeed(SCOPE);

    const [first, second] = vi.mocked(listEvents).mock.calls;
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain('feedSeenAt');
  });
});

describe('markFeedSeen', () => {
  it('writes the reader’s own membership row', async () => {
    const at = new Date('2026-10-06T12:00:00.000Z');

    expect(await markFeedSeen(SCOPE, at)).toBe(true);
    expect(setFeedSeenAt).toHaveBeenCalledWith('grp_1', 'user_me', at);
  });

  it('does nothing in a personal workspace', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue(null);

    expect(await markFeedSeen(SCOPE)).toBe(false);
    expect(setFeedSeenAt).not.toHaveBeenCalled();
  });

  it('does nothing without a reader', async () => {
    const anonymous = spaceScopeFor({ spaceId: 'spc_g', actorUserId: null, role: 'viewer' });

    expect(await markFeedSeen(anonymous)).toBe(false);
  });
});
