/**
 * PATCH  /api/v1/resparkable/comments/[id] — edit your own comment.
 * DELETE /api/v1/resparkable/comments/[id] — remove one.
 *
 * **The two verbs have deliberately different rules, and the asymmetry is the
 * design.**
 *
 * *Editing* is the author's alone. The owner of the item cannot rewrite a
 * grantee's sentence while leaving their name on it — that is worse than
 * removing it, and it is enforced in the `where` clause rather than checked
 * beforehand, so it travels with the statement rather than with a call site.
 *
 * *Deleting* is the author's **or the owner's**. Somebody else's words standing
 * in your own notes with no way to remove them is what makes people stop
 * sharing, and the owner already decides whether the grant exists at all, so
 * withholding the smaller gesture would protect nothing.
 *
 * Both take the thread's `entityType`/`entityId` alongside the comment id,
 * because access is resolved against the **item**, not the comment: a comment id
 * on its own would have to be looked up before anyone could be asked whether
 * they may touch it, which is a read before an authorisation.
 *
 * Both return the whole thread, so a client rendering a conversation is not left
 * guessing about anything said between its last read and this write.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';
import { removeComment, updateComment } from '@/lib/framework/resparkable/services/comments';
import {
  commentRefQuerySchema,
  updateCommentSchema,
} from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, updateCommentSchema);

  const comments = await updateComment(
    viewerFromSession(session),
    { entityType: body.entityType, entityId: body.entityId },
    id,
    body.body
  );
  // Not yours to edit, not there, or not a thread you can see. One answer.
  if (!comments) throw new NotFoundError('Not found');

  log.info('Resparkable comment edited', { id, entityType: body.entityType });

  return successResponse(comments, { count: comments.length });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const query = validateQueryParams(new URL(request.url).searchParams, commentRefQuerySchema);

  const comments = await removeComment(
    viewerFromSession(session),
    { entityType: query.entityType, entityId: query.entityId },
    id
  );
  if (!comments) throw new NotFoundError('Not found');

  log.info('Resparkable comment deleted', { id, entityType: query.entityType });

  return successResponse(comments, { count: comments.length });
});
