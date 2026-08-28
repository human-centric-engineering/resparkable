/**
 * Comment repo — the rows that make `role: 'commenter'` mean something.
 *
 * ## Why this is an owner query even when a grantee writes it
 *
 * A comment belongs to the **brain it was written into**, not to the person who
 * wrote it: `userId` is the owner of the commented-on item, so the row cascades
 * from `ResparkableSpace` like everything else in the tier and `WHERE userId =
 * $1` keeps meaning the same thing. That is the same choice `ResparkableGrant`
 * made, for the same reason (D1).
 *
 * So every function here takes an `OwnerScope` — including the write path, which
 * a grantee reaches. The scope is not minted from the writer's session; it comes
 * from a **positive access resolution** on the item (`sharedOwnerScope`), which
 * is what makes "you may write here" a decision the access layer made rather
 * than one this layer assumed.
 *
 * The author is carried separately, as `authorUserId`, and that is the only
 * field on any of these calls that names the person doing the writing.
 *
 * ## What this table is deliberately kept out of
 *
 * **A grantee's comment is third-party text arriving inside the owner's data**,
 * which makes it a prompt-injection vector aimed at the owner's own agent. It is
 * excluded from `ResparkableEmbedding`, from the context builder and from every
 * background workflow — structurally, by nothing in `embedding/**` or
 * `context/**` importing this file. There is no flag to get wrong, and adding
 * one would be the bug.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { nullOnMiss } from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';
import type { ResparkableComment } from '@prisma/client';

/** How many comments one item renders. Beyond this it is a forum, not a note. */
export const COMMENT_LIMIT = 200;

/**
 * The comments on one item, oldest first.
 *
 * Oldest first because a comment thread is read in the order it was said. Every
 * other list in this tier is newest-first, and the difference is deliberate
 * rather than an oversight: those are queues, and this is a conversation.
 */
export async function listComments(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityId: string
): Promise<ResparkableComment[]> {
  return prisma.resparkableComment.findMany({
    where: { ...ownerWhere(scope), entityType, entityId },
    orderBy: { createdAt: 'asc' },
    take: COMMENT_LIMIT,
  });
}

/**
 * How many comments sit on each of these items, for one owner.
 *
 * A `groupBy` rather than a count per row, for the reason every batched read in
 * this tier gives: a fifty-card board would otherwise be fifty queries.
 */
export async function countCommentsByEntity(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityIds: readonly string[]
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();

  const rows = await prisma.resparkableComment.groupBy({
    by: ['entityId'],
    where: { ...ownerWhere(scope), entityType, entityId: { in: [...entityIds] } },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.entityId, row._count._all]));
}

/**
 * Write a comment.
 *
 * `authorUserId` is passed rather than derived, because the writer is not
 * necessarily the owner and the two must not be confused at any point in the
 * call. The scope says whose brain this lands in; the author says who said it.
 */
export async function createComment(
  scope: OwnerScope,
  data: {
    entityType: ResparkableShareableType;
    entityId: string;
    authorUserId: string;
    body: string;
  }
): Promise<ResparkableComment> {
  return prisma.resparkableComment.create({
    data: {
      ...ownerWhere(scope),
      entityType: data.entityType,
      entityId: data.entityId,
      authorUserId: data.authorUserId,
      body: data.body,
    },
  });
}

/**
 * Edit a comment — **only the author may, and the query is what enforces it.**
 *
 * `authorUserId` is in the `where`, not checked in a service beforehand. A
 * read-then-write would be correct today and wrong the first time somebody adds
 * a second call site, whereas a `where` clause travels with the statement.
 *
 * The owner is deliberately **not** able to edit a grantee's comment. Editing
 * somebody else's words while leaving their name on them is worse than deleting
 * them, and the owner can do that instead — see {@link deleteComment}.
 */
export async function editComment(
  scope: OwnerScope,
  id: string,
  authorUserId: string,
  body: string,
  now: Date = new Date()
): Promise<ResparkableComment | null> {
  const result = await prisma.resparkableComment.updateMany({
    where: { ...ownerWhere(scope), id, authorUserId },
    data: { body, editedAt: now },
  });
  if (result.count === 0) return null;

  return prisma.resparkableComment.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Delete a comment.
 *
 * `authorUserId` is optional here, and that asymmetry with {@link editComment}
 * is the point: **the author may delete their own, and the owner may delete any
 * comment in their own brain.** Somebody else's words standing in your notes,
 * with no way to remove them, is the failure mode that makes people stop sharing
 * — and the owner already controls whether the grant exists at all, so denying
 * them the smaller gesture would protect nothing.
 *
 * Passing `authorUserId` restricts the delete to that person's own comment;
 * omitting it means the caller has already established owner authority.
 */
export async function deleteComment(
  scope: OwnerScope,
  id: string,
  authorUserId?: string
): Promise<ResparkableComment | null> {
  return nullOnMiss(() =>
    prisma.resparkableComment.delete({
      where: {
        id,
        ...ownerWhere(scope),
        ...(authorUserId ? { authorUserId } : {}),
      },
    })
  );
}

/**
 * The distinct authors of a set of comments.
 *
 * Reads core's `user` table, so it sits here for the reason
 * `repo/owner-contact.ts` gives at length: the tier's Prisma access is confined
 * to `repo/**` and `access/**` by ESLint, and keeping that absolute is worth
 * more than the tidiness of a file that only touches Resparkable models.
 *
 * Narrowed to a name and an id. **No email**, because a comment thread is not a
 * contact list: a grantee reading a shared project should learn who said a
 * thing, not how to reach every other person the owner shared it with.
 */
export async function findCommentAuthors(
  authorUserIds: readonly string[]
): Promise<Map<string, { id: string; name: string | null }>> {
  if (authorUserIds.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(authorUserIds)] } },
    select: { id: true, name: true },
  });

  return new Map(users.map((user) => [user.id, { id: user.id, name: user.name }]));
}
