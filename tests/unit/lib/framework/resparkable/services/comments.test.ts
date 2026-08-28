/**
 * Unit Tests: comments (Release 2, phase 13).
 *
 * Comments are the only write path in the tier a non-owner can reach, so what
 * has to hold is mostly about who is refused:
 *
 *   1. **`need: 'comment'` is asked of the resolver, not derived here.** A
 *      `viewer` grant, a **cascaded** grant of any role, and a public link all
 *      resolve `permissions.comment: false`; asking the right question is what
 *      stops this file getting one of the three wrong.
 *   2. **A cascaded item cannot be commented on**, even under a commenter grant
 *      on its parent. It was never chosen for sharing by its owner.
 *   3. **The scope always comes from a positive resolution**, never from the
 *      writer's session — the row lands in the *owner's* brain.
 *   4. **Editing is the author's alone; deleting is the author's or the
 *      owner's.** The author id travels into the query in every case but one,
 *      and that one is the owner deleting from their own brain.
 *   5. **A refusal to write and a missing item look identical.** "You may look
 *      but not speak" as a distinguishable answer tells a guesser which items
 *      exist.
 *
 * @see lib/framework/resparkable/services/comments.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveResparkableAccess = vi.fn();

vi.mock('@/lib/framework/resparkable/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/framework/resparkable/access')>(
    '@/lib/framework/resparkable/access'
  );
  return {
    ...actual,
    resolveResparkableAccess: (...args: unknown[]) => resolveResparkableAccess(...args),
  };
});

const listComments = vi.fn();
const createComment = vi.fn();
const editComment = vi.fn();
const deleteComment = vi.fn();
const findCommentAuthors = vi.fn();
const countCommentsByEntity = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/comments', () => ({
  listComments: (...args: unknown[]) => listComments(...args),
  createComment: (...args: unknown[]) => createComment(...args),
  editComment: (...args: unknown[]) => editComment(...args),
  deleteComment: (...args: unknown[]) => deleteComment(...args),
  findCommentAuthors: (...args: unknown[]) => findCommentAuthors(...args),
  countCommentsByEntity: (...args: unknown[]) => countCommentsByEntity(...args),
}));

import {
  addComment,
  listCommentsFor,
  removeComment,
  updateComment,
} from '@/lib/framework/resparkable/services/comments';

const NOW = new Date('2026-08-28T10:00:00.000Z');
const GRANTEE = { userId: 'user_b', email: 'b@example.com' };
const REF = { entityType: 'project', entityId: 'p_1' };

/** A commenter grant on the item itself — the only basis that may write. */
function commenterAccess(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    basis: 'grant',
    ownerId: 'user_a',
    permissions: { read: true, comment: true },
    redact: ['priorityScore', 'events', 'parent'],
    via: null,
    ...overrides,
  };
}

const DENIED = {
  ok: false,
  basis: null,
  ownerId: null,
  permissions: { read: false, comment: false },
  redact: [],
  via: null,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'p_1',
    authorUserId: 'user_b',
    body: 'Looks right to me',
    editedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveResparkableAccess.mockResolvedValue(commenterAccess());
  listComments.mockResolvedValue([row()]);
  findCommentAuthors.mockResolvedValue(new Map([['user_b', { id: 'user_b', name: 'Bo' }]]));
  createComment.mockResolvedValue(row());
  editComment.mockResolvedValue(row({ editedAt: NOW }));
  deleteComment.mockResolvedValue(row());
});

describe('listCommentsFor', () => {
  it('returns the thread with author names and no addresses', async () => {
    const thread = await listCommentsFor(GRANTEE, REF, NOW);

    expect(thread).toHaveLength(1);
    expect(thread?.[0].author.name).toBe('Bo');
    // A thread is not a contact list: a grantee reading a shared project should
    // learn who said a thing, not how to reach everyone else it was shared with.
    expect(JSON.stringify(thread)).not.toContain('@');
  });

  it('marks the reader’s own comment, and the owner’s', async () => {
    listComments.mockResolvedValue([
      row({ id: 'c_mine', authorUserId: 'user_b' }),
      row({ id: 'c_theirs', authorUserId: 'user_a' }),
    ]);
    findCommentAuthors.mockResolvedValue(
      new Map([
        ['user_b', { id: 'user_b', name: 'Bo' }],
        ['user_a', { id: 'user_a', name: 'Priya' }],
      ])
    );

    const thread = await listCommentsFor(GRANTEE, REF, NOW);

    expect(thread?.[0]).toMatchObject({ mine: true, author: { isOwner: false } });
    expect(thread?.[1]).toMatchObject({ mine: false, author: { isOwner: true } });
  });

  it('returns null when the basis carries no comments', async () => {
    // `comments` in the redaction set is the whole answer, and it is the
    // resolver's answer — a public link and a cascaded grant both carry it.
    resolveResparkableAccess.mockResolvedValue(commenterAccess({ redact: ['comments'] }));

    expect(await listCommentsFor(GRANTEE, REF, NOW)).toBeNull();
    expect(listComments).not.toHaveBeenCalled();
  });

  it('returns null on a denial, without reading anything', async () => {
    resolveResparkableAccess.mockResolvedValue(DENIED);

    expect(await listCommentsFor(GRANTEE, REF, NOW)).toBeNull();
    expect(listComments).not.toHaveBeenCalled();
  });
});

describe('addComment', () => {
  it('asks the resolver for comment permission, not for read', async () => {
    await addComment(GRANTEE, REF, 'Looks right to me', NOW);

    // Asking for `read` and checking a role here would be a second copy of a
    // rule the resolver already applies, and the cascaded case is the one that
    // copy would get wrong.
    expect(resolveResparkableAccess.mock.calls[0][0]).toMatchObject({ need: 'comment' });
  });

  it('writes into the OWNER’s brain, with the writer as author', async () => {
    await addComment(GRANTEE, REF, 'Looks right to me', NOW);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      expect.objectContaining({ authorUserId: 'user_b', body: 'Looks right to me' })
    );
  });

  it('refuses a viewer grant', async () => {
    resolveResparkableAccess.mockResolvedValue(
      commenterAccess({ permissions: { read: true, comment: false } })
    );

    expect(await addComment(GRANTEE, REF, 'hello', NOW)).toBeNull();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('refuses a cascaded grant, whatever its role', async () => {
    resolveResparkableAccess.mockResolvedValue(
      commenterAccess({
        basis: 'grant-cascade',
        permissions: { read: true, comment: false },
        via: { entityType: 'project', entityId: 'p_parent' },
      })
    );

    // The item was never chosen for sharing by its owner. Commenting is
    // something you do to the thing that was actually handed over.
    expect(
      await addComment(GRANTEE, { entityType: 'task', entityId: 't_1' }, 'hi', NOW)
    ).toBeNull();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('refuses an anonymous viewer, because a comment needs an author', async () => {
    expect(await addComment({ userId: null, email: null }, REF, 'hi', NOW)).toBeNull();
    expect(resolveResparkableAccess).not.toHaveBeenCalled();
  });

  it('returns the whole thread, not the one row it wrote', async () => {
    listComments.mockResolvedValue([row({ id: 'c_earlier' }), row({ id: 'c_new' })]);

    const thread = await addComment(GRANTEE, REF, 'Looks right to me', NOW);

    // A conversation changes between reads. Appending the one returned row
    // would leave the reader confidently looking at a thread missing whatever
    // was said in between.
    expect(thread).toHaveLength(2);
  });

  it('never logs the comment body', async () => {
    const { logger } = await import('@/lib/logging');
    const info = vi.spyOn(logger, 'info');

    await addComment(GRANTEE, REF, 'the merger closes on Tuesday', NOW);

    expect(JSON.stringify(info.mock.calls)).not.toContain('merger');
    info.mockRestore();
  });
});

describe('updateComment', () => {
  it('puts the author id in the query, so only the author can edit', async () => {
    await updateComment(GRANTEE, REF, 'c_1', 'Changed my mind', NOW);

    expect(editComment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'c_1',
      'user_b',
      'Changed my mind',
      NOW
    );
  });

  it('gives the OWNER no way to edit somebody else’s words', async () => {
    resolveResparkableAccess.mockResolvedValue(
      commenterAccess({ basis: 'owner', ownerId: 'user_a', redact: [] })
    );
    editComment.mockResolvedValue(null);

    // The owner's own id still travels into the `where`, so editing a
    // grantee's comment matches nothing. Rewriting a person's sentence while
    // leaving their name on it is worse than removing it — and the owner can
    // remove it.
    expect(
      await updateComment({ userId: 'user_a', email: 'a@example.com' }, REF, 'c_1', 'no', NOW)
    ).toBeNull();
    expect(editComment.mock.calls[0][2]).toBe('user_a');
  });
});

describe('removeComment', () => {
  it('restricts a grantee to their own comment', async () => {
    await removeComment(GRANTEE, REF, 'c_1', NOW);

    expect(deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'c_1',
      'user_b'
    );
  });

  it('lets the owner remove any comment in their own brain', async () => {
    resolveResparkableAccess.mockResolvedValue(
      commenterAccess({ basis: 'owner', ownerId: 'user_a', redact: [] })
    );

    await removeComment({ userId: 'user_a', email: 'a@example.com' }, REF, 'c_1', NOW);

    // The author filter is dropped only here, and only for the owner. Somebody
    // else's words standing in your notes with no way to remove them is what
    // makes people stop sharing.
    expect(deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'c_1',
      undefined
    );
  });

  it('returns null when nothing was removed', async () => {
    deleteComment.mockResolvedValue(null);

    expect(await removeComment(GRANTEE, REF, 'c_someone_else', NOW)).toBeNull();
  });
});
