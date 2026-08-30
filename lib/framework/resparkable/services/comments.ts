/**
 * Comments — the one thing a grantee can write, and the only write path in the
 * tier that a non-owner reaches.
 *
 * ## Everything here starts with a resolution, and the scope comes from it
 *
 * The owner scope every call passes down is minted by `sharedSpaceScope` from a
 * **positive** `ResparkableAccessResult`. That is what makes "may this person
 * write here?" a decision the access layer made, from a grant it read, rather
 * than an assumption this layer arrived at from a session id. There is no path
 * through this file that constructs a scope any other way.
 *
 * ## `need: 'comment'` is not `need: 'read'` plus a role check
 *
 * The resolver already knows: a `viewer` grant, a cascaded grant of any role,
 * and a public link all resolve `permissions.comment: false`. Asking it the
 * right question means this file never re-derives the answer, and never gets
 * one of the three cases wrong.
 *
 * The cascaded case is the one worth naming. **A cascaded item cannot be
 * commented on, even under a commenter grant on its parent.** It was never
 * chosen for sharing by its owner; commenting is something you do to the thing
 * that was actually handed over.
 *
 * ## What a comment must never become
 *
 * **Third-party text arriving inside the owner's data is a prompt-injection
 * vector aimed at the owner's own agent** (§13). Comments are excluded from
 * embeddings, from the context builder and from every background workflow —
 * structurally, by nothing in `embedding/**` or `context/**` reading the table.
 * If a future feature wants "summarise the discussion", it has to make that
 * exposure an explicit, separate decision rather than inherit it.
 */

import {
  isResparkableShareableType,
  resolveResparkableAccess,
  sharedSpaceScope,
  type ResparkableShareableType,
  type ResparkableViewer,
} from '@/lib/framework/resparkable/access';
import {
  createComment,
  deleteComment,
  editComment,
  findCommentAuthors,
  listComments,
} from '@/lib/framework/resparkable/repo/comments';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { logger } from '@/lib/logging';

/** One comment, as anybody entitled to read the thread sees it. */
export interface CommentView {
  id: string;
  body: string;
  author: {
    id: string;
    /** `null` for an account with no name set. Never an email — see the repo. */
    name: string | null;
    /** Whether this comment was written by the person whose item it sits on. */
    isOwner: boolean;
  };
  /** True for the person reading it, so the UI can offer edit and delete. */
  mine: boolean;
  editedAt: Date | null;
  createdAt: Date;
}

/**
 * The comments on one item, for a viewer who may or may not be its owner.
 *
 * Returns `null` when the viewer cannot see the item at all, or when their
 * basis does not carry comments — which means a **public link**. A cascaded
 * grant does read the thread; see the note at the guard for why. The route
 * turns `null` into a 404, so "no access" and "no such item" stay the same
 * answer.
 */
export async function listCommentsFor(
  viewer: ResparkableViewer,
  ref: { entityType: string; entityId: string },
  now: Date = new Date()
): Promise<CommentView[] | null> {
  const entityType = shareableTypeOf(ref);
  if (!entityType) return null;

  const access = await resolveResparkableAccess({
    viewer,
    entityType,
    entityId: ref.entityId,
    need: 'read',
    now,
  });
  if (!access.ok) return null;

  // `comments` in the redaction set is the whole answer, and it is a **public
  // link** this excludes — not a cascade.
  //
  // Worth stating precisely, because an earlier version of this comment said
  // "a public link and a cascaded grant both carry it" and that is false.
  // `redactionsFor` opens `comments` for `grant` and `grant-cascade` alike, and
  // `access/types.ts` argues the case: the cascade only ever runs inside one
  // brain the viewer was already given a door into, so a grantee who can read
  // the project can already read what was said on it — and withholding the
  // thread one level down would leave them looking at comments on a project and
  // none on its tasks, which reads as a bug rather than as care.
  //
  // What a cascade does withhold is the ability to *write*: `permissions.comment`
  // is false for it, which `addComment` asks about separately. Reading and
  // writing are different questions and this file answers them with different
  // fields on purpose.
  if (access.redact.includes('comments')) return null;

  const scope = sharedSpaceScope(access, viewer.userId);
  return hydrate(scope, entityType, ref.entityId, viewer, access.ownerId);
}

/**
 * Write a comment.
 *
 * Returns `null` for every refusal — no access, read-only access, a cascaded
 * item, a public link — because the route's answer is a 404 in all of them and
 * distinguishing "you may look but not speak" from "there is nothing here"
 * tells a guesser which items exist.
 *
 * Anonymous viewers cannot reach this: a comment needs an author, and
 * `viewer.userId` is what supplies one.
 */
export async function addComment(
  viewer: ResparkableViewer,
  ref: { entityType: string; entityId: string },
  body: string,
  now: Date = new Date()
): Promise<CommentView[] | null> {
  if (!viewer.userId) return null;

  const entityType = shareableTypeOf(ref);
  if (!entityType) return null;

  const access = await resolveResparkableAccess({
    viewer,
    entityType,
    entityId: ref.entityId,
    need: 'comment',
    now,
  });
  if (!access.ok || !access.permissions.comment) return null;

  const scope = sharedSpaceScope(access, viewer.userId);

  await createComment(scope, {
    entityType,
    entityId: ref.entityId,
    authorUserId: viewer.userId,
    body,
  });

  // No body, and no author address. A comment is content, and a log line is
  // the one place content most reliably outlives the system that held it.
  logger.info('Resparkable comment added', {
    entityType,
    basis: access.basis,
  });

  // The whole thread back, not the one row. The client is rendering a
  // conversation, and a single appended comment leaves it guessing about
  // anything said between its last read and this write.
  return hydrate(scope, entityType, ref.entityId, viewer, access.ownerId);
}

/**
 * Edit a comment. **Author only**, enforced in the `where` clause.
 *
 * The owner cannot edit somebody else's words. Rewriting a person's sentence
 * while leaving their name on it is worse than removing it, and the owner can
 * remove it — see {@link removeComment}.
 */
export async function updateComment(
  viewer: ResparkableViewer,
  ref: { entityType: string; entityId: string },
  commentId: string,
  body: string,
  now: Date = new Date()
): Promise<CommentView[] | null> {
  if (!viewer.userId) return null;

  const entityType = shareableTypeOf(ref);
  if (!entityType) return null;

  const access = await resolveResparkableAccess({
    viewer,
    entityType,
    entityId: ref.entityId,
    need: 'read',
    now,
  });
  if (!access.ok || access.redact.includes('comments')) return null;

  const scope = sharedSpaceScope(access, viewer.userId);
  const edited = await editComment(
    scope,
    { entityType, entityId: ref.entityId },
    commentId,
    viewer.userId,
    body,
    now
  );
  if (!edited) return null;

  return hydrate(scope, entityType, ref.entityId, viewer, access.ownerId);
}

/**
 * Delete a comment.
 *
 * **The author may delete their own; the owner may delete any in their own
 * brain.** That asymmetry with editing is deliberate: somebody else's words
 * standing in your notes with no way to remove them is what makes people stop
 * sharing, and the owner already decides whether the grant exists at all, so
 * withholding the smaller gesture would protect nothing.
 */
export async function removeComment(
  viewer: ResparkableViewer,
  ref: { entityType: string; entityId: string },
  commentId: string,
  now: Date = new Date()
): Promise<CommentView[] | null> {
  if (!viewer.userId) return null;

  const entityType = shareableTypeOf(ref);
  if (!entityType) return null;

  const access = await resolveResparkableAccess({
    viewer,
    entityType,
    entityId: ref.entityId,
    need: 'read',
    now,
  });
  if (!access.ok || access.redact.includes('comments')) return null;

  const scope = sharedSpaceScope(access, viewer.userId);
  const isOwner = access.basis === 'owner';

  // The author filter is dropped only for the owner, and only here. Everywhere
  // else in this file the writer's id travels into the query.
  const removed = await deleteComment(
    scope,
    { entityType, entityId: ref.entityId },
    commentId,
    isOwner ? undefined : viewer.userId
  );
  if (!removed) return null;

  logger.info('Resparkable comment deleted', { entityType, byOwner: isOwner });

  return hydrate(scope, entityType, ref.entityId, viewer, access.ownerId);
}

/**
 * Narrow a route's `entityType` to the shareable union, or refuse.
 *
 * A guard rather than a cast, and the difference is not cosmetic. `as` would
 * assert something about a string that arrived from a URL segment; this asks.
 * The resolver denies unshareable types anyway, so the cast happened to be true
 * — but "true because something downstream would have caught it" is exactly the
 * shape that stops being true when the something downstream is refactored.
 *
 * Returning `null` rather than throwing keeps every refusal on this surface the
 * same refusal: an unshareable type and a missing item are one 404.
 */
function shareableTypeOf(ref: { entityType: string }): ResparkableShareableType | null {
  return isResparkableShareableType(ref.entityType) ? ref.entityType : null;
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Load a thread and attach its authors' names.
 *
 * One extra query for the whole thread, not one per comment. Names rather than
 * addresses: a comment thread is not a contact list, and a grantee reading a
 * shared project should learn who said a thing without learning how to reach
 * everybody else the owner shared it with.
 */
async function hydrate(
  scope: SpaceScope,
  entityType: ResparkableShareableType,
  entityId: string,
  viewer: ResparkableViewer,
  ownerId: string | null
): Promise<CommentView[]> {
  const rows = await listComments(scope, entityType, entityId);
  if (rows.length === 0) return [];

  const authors = await findCommentAuthors(rows.map((row) => row.authorUserId));

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    author: {
      id: row.authorUserId,
      // An author erased since they wrote it cannot reach here — the row goes
      // with them (probe B9) — so a missing name is an account with none set.
      name: authors.get(row.authorUserId)?.name ?? null,
      isOwner: row.authorUserId === ownerId,
    },
    mine: row.authorUserId === viewer.userId,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
  }));
}
