/**
 * GET  /api/v1/resparkable/comments?entityType=&entityId= — read a thread.
 * POST /api/v1/resparkable/comments — say something.
 *
 * **The only write path in the tier a non-owner can reach**, and the only thing
 * `role: 'commenter'` means. Every other shared surface is read-only; a grant is
 * `viewer` or `commenter`, and neither implies any authority over the item.
 *
 * Both verbs resolve access on this request. The POST asks the resolver for
 * `need: 'comment'` rather than asking for `read` and checking a role, so the
 * three cases that must not write — a `viewer` grant, a **cascaded** grant of
 * any role, and a public link — are all refused by one answer rather than by
 * three checks somebody has to keep in step.
 *
 * The cascaded case is the one worth naming: a task inside a shared project
 * cannot be commented on even under a commenter grant on the project. It was
 * never chosen for sharing by its owner, and commenting is something you do to
 * the thing that was actually handed over.
 *
 * Every refusal is the same 404 — no access, read-only access, a cascaded item,
 * an unshareable type, a deleted item. "You may look but not speak" and "there
 * is nothing here" have to be indistinguishable, or the response tells a
 * guesser which items exist.
 *
 * Authentication: required. A comment needs an author, and the session is the
 * only thing that supplies one.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';
import { addComment, listCommentsFor } from '@/lib/framework/resparkable/services/comments';
import {
  commentRefQuerySchema,
  createCommentSchema,
} from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const query = validateQueryParams(new URL(request.url).searchParams, commentRefQuerySchema);

  const comments = await listCommentsFor(viewerFromSession(session), query);
  if (!comments) throw new NotFoundError('Not found');

  log.info('Resparkable comments list', {
    entityType: query.entityType,
    count: comments.length,
  });

  return successResponse(comments, { count: comments.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, createCommentSchema);

  const comments = await addComment(
    viewerFromSession(session),
    { entityType: body.entityType, entityId: body.entityId },
    body.body
  );
  if (!comments) throw new NotFoundError('Not found');

  // Never the comment text. It is content, and a log line is the one place
  // content most reliably outlives the system that held it.
  log.info('Resparkable comment added', { entityType: body.entityType });

  return successResponse(comments, { count: comments.length }, { status: 201 });
});
