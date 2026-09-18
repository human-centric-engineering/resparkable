/**
 * Route-handler factories for Resparkable's CRUD surface.
 *
 * Every Resparkable route file is two lines: import a descriptor, spread the
 * handlers. That is deliberate — twenty hand-written route files is twenty
 * chances to forget `withAuth`, forget the scope, or return a 403 where the
 * isolation contract says 404. Here there is one implementation to review.
 *
 * The three properties that matter, all enforced in this file:
 *
 *   1. **The actor comes from the session, always, and the workspace comes from
 *      the URL.** `requestSpaceScope(request, session.user.id)` is the only
 *      thing in this file that produces a scope: the actor is verified, the
 *      `?space=` target is not, and membership decides whether the two go
 *      together (phase 47). A body or query field called `userId` still cannot
 *      reach a repo, because the schemas are `.strict()` and reject it
 *      outright, and neither can a body field naming a space.
 *   2. **Missing and not-yours are indistinguishable.** Repos return `null` for
 *      both, and both become `NotFoundError` — never `ForbiddenError`, which
 *      would confirm the row exists (plan §16.2).
 *   3. **No rate limiting here.** `/api/v1/**` already inherits the section cap
 *      from `proxy.ts`; calling a section limiter in a handler double-counts
 *      (CLAUDE.md, `.context/security/gotchas.md` #2). Per-flow sub-caps for
 *      the embedding-heavy routes arrive with those routes in phase 4.
 */

import type { NextRequest } from 'next/server';

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { entityExists } from '@/lib/framework/resparkable/repo/summaries';
import type { ResparkableResource } from '@/lib/framework/resparkable/services/resources';
import {
  snoozeItem,
  unsnoozeItem,
  type SnoozableType,
} from '@/lib/framework/resparkable/services/snooze';
import { archiveSchema, snoozeSchema } from '@/lib/framework/resparkable/validations';
import { RESPARKABLE_CONTEXT_DIGEST_WORKFLOW_SLUG } from '@/lib/framework/resparkable/workflows/definitions';

/** A handler on a collection route — no dynamic segment to await. */
type CollectionHandler = (request: NextRequest) => Promise<Response>;

/** A handler on an `[id]` route. Next 16 hands params over as a promise. */
type ItemHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

/** Collection handlers: `GET /resparkable/<plural>` and `POST /resparkable/<plural>`. */
export function createCollectionHandlers<TCreate, TUpdate, TQuery>(
  resource: ResparkableResource<TCreate, TUpdate, TQuery>
): { GET: CollectionHandler; POST: CollectionHandler } {
  const GET = withAuth(async (request, session) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);

    const query = validateQueryParams(new URL(request.url).searchParams, resource.listQuerySchema);
    const { items, total } = await resource.list(scope, query);

    log.info('Resparkable list', { resource: resource.name, count: items.length, total });

    return successResponse(items, { total, count: items.length });
  });

  const POST = withAuth(async (request, session) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);

    const body = await validateRequestBody(request, resource.createSchema);
    const created = await resource.create(scope, body);

    log.info('Resparkable created', { resource: resource.name });

    return successResponse(created, undefined, { status: 201 });
  });

  return { GET, POST };
}

/** Item handlers: `GET`, `PATCH` and `DELETE` on `/resparkable/<plural>/[id]`. */
export function createItemHandlers<TCreate, TUpdate, TQuery>(
  resource: ResparkableResource<TCreate, TUpdate, TQuery>
): { GET: ItemHandler; PATCH: ItemHandler; DELETE: ItemHandler } {
  const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    const item = await resource.get(scope, id);
    // Another user's id lands here as `null`, exactly like a typo — the
    // response must not distinguish them.
    if (!item) throw new NotFoundError(`${resource.name} not found`);

    log.info('Resparkable item read', { resource: resource.name, id });

    return successResponse(item);
  });

  const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    const body = await validateRequestBody(request, resource.updateSchema);
    const updated = await resource.update(scope, id, body);
    if (!updated) throw new NotFoundError(`${resource.name} not found`);

    log.info('Resparkable updated', { resource: resource.name, id });

    return successResponse(updated);
  });

  /**
   * DELETE archives by default; `?permanent=true` destroys.
   *
   * The plan is explicit that archiving is the reversible action and that
   * nothing a human wrote should be destroyed casually (§11), but it doesn't
   * say which verb does which — this is the reading that makes the dangerous
   * operation the one you have to ask for. Types without an archive lifecycle
   * (time blocks, which are pruned rather than archived) delete either way.
   */
  const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    const permanent = new URL(request.url).searchParams.get('permanent') === 'true';

    if (permanent || !resource.archive) {
      const removed = await resource.remove(scope, id);
      if (!removed) throw new NotFoundError(`${resource.name} not found`);
      log.info('Resparkable deleted', { resource: resource.name, id, permanent: true });
      return successResponse({ id, deleted: true });
    }

    const archived = await resource.archive(scope, id, 'manual');
    if (!archived) throw new NotFoundError(`${resource.name} not found`);

    log.info('Resparkable archived', { resource: resource.name, id });

    return successResponse(archived);
  });

  return { GET, PATCH, DELETE };
}

/**
 * `POST /resparkable/<plural>/[id]/restore`.
 *
 * Restoring nulls `indexedHash` so the tick re-embeds the item — an archived
 * item's vectors are deleted outright rather than filtered, so coming back
 * means being re-indexed (§11). The repo does that; this just exposes it.
 */
export function createRestoreHandler<TCreate, TUpdate, TQuery>(
  resource: ResparkableResource<TCreate, TUpdate, TQuery>
): { POST: ItemHandler } {
  const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    if (!resource.restore) throw new NotFoundError(`${resource.name} not found`);

    const restored = await resource.restore(scope, id);
    if (!restored) throw new NotFoundError(`${resource.name} not found`);

    log.info('Resparkable restored', { resource: resource.name, id });

    return successResponse(restored);
  });

  return { POST };
}

/**
 * `POST /resparkable/<plural>/[id]/snooze` and `.../unsnooze`.
 *
 * A pair rather than a `PATCH` of the underlying column, because the gesture
 * carries behaviour the column does not: a preset resolves in the user's zone,
 * `snoozeCount` increments, and an event is logged. Exposing the raw field
 * instead would let a caller move the date without any of that happening, and
 * the chronic-snooze signal — the most interesting thing here — would quietly
 * undercount.
 */
export function createSnoozeHandlers(type: SnoozableType): {
  POST: ItemHandler;
} {
  const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    const body = await validateRequestBody(request, snoozeSchema);
    const result = await snoozeItem(scope, type, id, body);
    if (!result) throw new NotFoundError(`${type} not found`);

    log.info('Resparkable snoozed', { type, id, preset: body.preset ?? 'custom' });

    return successResponse(result);
  });

  return { POST };
}

export function createUnsnoozeHandlers(type: SnoozableType): { POST: ItemHandler } {
  const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    const result = await unsnoozeItem(scope, type, id);
    if (!result) throw new NotFoundError(`${type} not found`);

    log.info('Resparkable unsnoozed', { type, id });

    return successResponse(result);
  });

  return { POST };
}

/** The three entity types the description-summariser can be pointed at (Release 8). */
export type SummarizableType = 'area' | 'goal' | 'project';

/**
 * `POST .../[id]/summarize` — queue the description-summary workflow.
 *
 * Same shape as `createSnoozeHandlers` above and the same reasoning as
 * `POST /resparkable/briefing/regenerate`: this **queues** rather than runs.
 * `queueResparkableWorkflowRun` writes a `PENDING` execution and the
 * maintenance tick picks it up — reimplementing version resolution and budget
 * handling in a route handler would drift from the real scheduler.
 *
 * The existence check happens here, before queuing, rather than inside the
 * workflow's own gather step — a request for an id that isn't the caller's
 * gets a 404 immediately instead of a queued execution that fails a minute
 * later with nothing to show for it.
 */
export function createSummarizeHandlers(type: SummarizableType): { POST: ItemHandler } {
  const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = await requestSpaceScope(request, session.user.id);
    const { id } = await params;

    if (!(await entityExists(scope, type, id))) throw new NotFoundError(`${type} not found`);

    const executionId = await queueResparkableWorkflowRun(
      RESPARKABLE_CONTEXT_DIGEST_WORKFLOW_SLUG,
      session.user.id,
      { entityType: type, entityId: id }
    );

    if (!executionId) {
      log.warn('Resparkable description summary: workflow unavailable', { type, id });
      return errorResponse(
        'The description-summary workflow is not available. Run the Resparkable seeds.',
        { code: 'WORKFLOW_UNAVAILABLE', status: 503 }
      );
    }

    log.info('Resparkable description summary queued', { type, id, executionId });

    return successResponse({ executionId, status: 'queued' });
  });

  return { POST };
}
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';

/** Exported for the archive-reason schema so route files stay two lines. */
export { archiveSchema };
