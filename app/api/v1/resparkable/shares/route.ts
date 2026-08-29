/**
 * GET /api/v1/resparkable/shares — everything this owner has shared out.
 *
 * The inverse of `/shared` (`/shared-with-me`), and worth stating so the two
 * are never merged: that one answers "what have other people given me?" and
 * reads their rows through a grant; this one answers "what have I given away?"
 * and reads the owner's own rows and the grants they issued. Different
 * question, different direction, and per D5 this one is an ordinary owner
 * query with no access layer anywhere near it.
 *
 * **Why it exists.** `ShareDialog` is only reachable through an entity's own
 * control, so a share on an entity the owner can no longer navigate to (a
 * replaced review, an archived project) could not be revoked at all. This is
 * the surface that makes every share revocable regardless of what happened to
 * the thing it points at. The service docblock has the three ways an entity
 * stops being reachable.
 *
 * Read-only. Revoking still goes through `DELETE /grants/[id]` and
 * `DELETE /share-links/[id]`, which already exist, already scope to the owner
 * and already flip `visibility` back to private when the last live link on an
 * entity goes. Adding a second revoke path here would be a second definition of
 * what revocation means, and two definitions drift.
 *
 * A `GET`, so the section's 100/min cap from `proxy.ts` is the whole rate-limit
 * story: no sub-cap, because the handler is eight indexed queries and no model
 * call.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { listMyShares, summariseShares } from '@/lib/framework/resparkable/services/my-shares';
import { mySharesQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = spaceScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, mySharesQuerySchema);

  const items = await listMyShares(scope, query);
  const totals = summariseShares(items);

  // `unreachable` is logged because it is the number that says whether this
  // page earned its place: shares the owner had no other way to reach.
  log.info('Resparkable outbound shares listed', totals);

  return successResponse(items, totals);
});
