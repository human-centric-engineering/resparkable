/**
 * Unit Tests: the comment repo.
 *
 * The queries are the contract, so these assert what is handed to Prisma. Three
 * things have to hold and none of them shows up in a returned value:
 *
 *   1. **Every query carries the owner** — a comment belongs to the brain it was
 *      written into, not to the person who wrote it, which is what keeps
 *      `WHERE userId = $1` meaning the same thing here as everywhere else.
 *   2. **The author id is in the `where` on an edit, not checked beforehand.**
 *      A read-then-write is correct today and wrong the first time somebody adds
 *      a second call site; a `where` clause travels with the statement.
 *   3. **The author filter is optional on a delete, and only there.** The author
 *      may remove their own, and the owner may remove any in their own brain.
 *
 * @see lib/framework/resparkable/repo/comments.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableComment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
    },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from '@/lib/db/client';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  createComment,
  deleteComment,
  editComment,
  findCommentAuthors,
  listComments,
} from '@/lib/framework/resparkable/repo/comments';

const OWNER = spaceScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listComments', () => {
  it('scopes to the owner and reads oldest first', async () => {
    await listComments(OWNER, 'project', 'p_1');

    const args = vi.mocked(prisma.resparkableComment.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({ spaceId: 'user_a', entityType: 'project', entityId: 'p_1' });
    // Every other list in this tier is newest-first. Those are queues; this is
    // a conversation, and a conversation is read in the order it was said.
    expect(args?.orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('createComment', () => {
  it('writes the owner from the scope and the author from the argument', async () => {
    await createComment(OWNER, {
      entityType: 'project',
      entityId: 'p_1',
      authorUserId: 'user_b',
      body: 'Looks right',
    });

    // The two must not be confused at any point: the scope says whose brain
    // this lands in, the author says who said it.
    expect(vi.mocked(prisma.resparkableComment.create).mock.calls[0][0].data).toMatchObject({
      spaceId: 'user_a',
      authorUserId: 'user_b',
    });
  });
});

const REF = { entityType: 'project' as const, entityId: 'p_1' };

describe('editComment', () => {
  it('puts the author AND the thread in the where clause, not in a prior check', async () => {
    vi.mocked(prisma.resparkableComment.updateMany).mockResolvedValue({ count: 0 });

    expect(await editComment(OWNER, REF, 'c_1', 'user_b', 'Changed', NOW)).toBeNull();

    const args = vi.mocked(prisma.resparkableComment.updateMany).mock.calls[0][0];
    // `entityType`/`entityId` are in the `where` because access was resolved
    // against the ITEM. A comment id belonging to a different item was never
    // covered by that resolution, and without these two the write would land on
    // one thread while the response returned another.
    expect(args.where).toEqual({
      spaceId: 'user_a',
      id: 'c_1',
      authorUserId: 'user_b',
      entityType: 'project',
      entityId: 'p_1',
    });
    expect(args.data).toEqual({ body: 'Changed', editedAt: NOW });
  });

  it('cannot reach a comment on another of the owner’s own items', async () => {
    vi.mocked(prisma.resparkableComment.updateMany).mockResolvedValue({ count: 0 });

    // The row exists and the owner owns it — but it sits on a different thread,
    // so it matches nothing and the caller gets the same null as a miss.
    expect(
      await editComment(
        OWNER,
        { entityType: 'task', entityId: 't_other' },
        'c_1',
        'user_a',
        'x',
        NOW
      )
    ).toBeNull();
  });
});

describe('deleteComment', () => {
  it('restricts to the author when one is given', async () => {
    await deleteComment(OWNER, REF, 'c_1', 'user_b');

    expect(vi.mocked(prisma.resparkableComment.delete).mock.calls[0][0].where).toEqual({
      id: 'c_1',
      spaceId: 'user_a',
      authorUserId: 'user_b',
      entityType: 'project',
      entityId: 'p_1',
    });
  });

  it('drops the author filter when the caller has owner authority', async () => {
    await deleteComment(OWNER, REF, 'c_1');

    // Still owner-scoped. What is dropped is the *author* predicate, which is
    // what lets an owner remove somebody else's words from their own brain —
    // the gesture that stops "I cannot get this off my page" being a reason to
    // stop sharing.
    expect(vi.mocked(prisma.resparkableComment.delete).mock.calls[0][0].where).toEqual({
      id: 'c_1',
      spaceId: 'user_a',
      // The thread predicate stays even for the owner: dropping the AUTHOR
      // filter is what owner authority buys, not the ability to reach a
      // comment on some other item.
      entityType: 'project',
      entityId: 'p_1',
    });
  });
});

describe('findCommentAuthors', () => {
  it('selects a name and an id, and never an address', async () => {
    await findCommentAuthors(['user_b', 'user_b', 'user_c']);

    const args = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    // A comment thread is not a contact list. A value that is never fetched
    // cannot be leaked by a serialiser downstream.
    expect(args?.select).toEqual({ id: true, name: true });
    // De-duplicated: two comments by one person is one row to read.
    expect(args?.where).toEqual({ id: { in: ['user_b', 'user_c'] } });
  });

  it('asks nothing when there are no comments', async () => {
    expect(await findCommentAuthors([])).toEqual(new Map());
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
