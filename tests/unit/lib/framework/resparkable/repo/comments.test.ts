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
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  countCommentsByEntity,
  createComment,
  deleteComment,
  editComment,
  findCommentAuthors,
  listComments,
} from '@/lib/framework/resparkable/repo/comments';

const OWNER = ownerScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listComments', () => {
  it('scopes to the owner and reads oldest first', async () => {
    await listComments(OWNER, 'project', 'p_1');

    const args = vi.mocked(prisma.resparkableComment.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({ userId: 'user_a', entityType: 'project', entityId: 'p_1' });
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
      userId: 'user_a',
      authorUserId: 'user_b',
    });
  });
});

describe('editComment', () => {
  it('puts the author in the where clause, not in a prior check', async () => {
    vi.mocked(prisma.resparkableComment.updateMany).mockResolvedValue({ count: 0 });

    expect(await editComment(OWNER, 'c_1', 'user_b', 'Changed', NOW)).toBeNull();

    const args = vi.mocked(prisma.resparkableComment.updateMany).mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user_a', id: 'c_1', authorUserId: 'user_b' });
    expect(args.data).toEqual({ body: 'Changed', editedAt: NOW });
  });
});

describe('deleteComment', () => {
  it('restricts to the author when one is given', async () => {
    await deleteComment(OWNER, 'c_1', 'user_b');

    expect(vi.mocked(prisma.resparkableComment.delete).mock.calls[0][0].where).toEqual({
      id: 'c_1',
      userId: 'user_a',
      authorUserId: 'user_b',
    });
  });

  it('drops the author filter when the caller has owner authority', async () => {
    await deleteComment(OWNER, 'c_1');

    // Still owner-scoped. What is dropped is the *author* predicate, which is
    // what lets an owner remove somebody else's words from their own brain —
    // the gesture that stops "I cannot get this off my page" being a reason to
    // stop sharing.
    expect(vi.mocked(prisma.resparkableComment.delete).mock.calls[0][0].where).toEqual({
      id: 'c_1',
      userId: 'user_a',
    });
  });
});

describe('countCommentsByEntity', () => {
  it('asks nothing for an empty id list', async () => {
    expect(await countCommentsByEntity(OWNER, 'task', [])).toEqual(new Map());
    expect(prisma.resparkableComment.groupBy).not.toHaveBeenCalled();
  });

  it('counts in one grouped query, owner-scoped', async () => {
    vi.mocked(prisma.resparkableComment.groupBy).mockResolvedValue([
      { entityId: 't_1', _count: { _all: 2 } },
    ] as never);

    const counts = await countCommentsByEntity(OWNER, 'task', ['t_1', 't_2']);

    expect(prisma.resparkableComment.groupBy).toHaveBeenCalledTimes(1);
    expect(counts.get('t_1')).toBe(2);
    expect(counts.has('t_2')).toBe(false);
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
