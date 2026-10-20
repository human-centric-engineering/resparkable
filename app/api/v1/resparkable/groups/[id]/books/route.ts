/**
 * GET /api/v1/resparkable/groups/[id]/books: the group's books (phase 62).
 *
 * For every joined member, viewers included: where the group's credits went, by
 * person, by category and by week. Money, never output, and people listed by
 * name rather than by amount (§23.12's second amendment). The rules live in
 * `services/group-books.ts`, so they cannot drift between surfaces.
 *
 * `?weeks=` is how many weeks back, 1 to 52, default 12.
 *
 * Keyed on the actor and the group id like every group route; reads no
 * `?space=`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { getGroupBooks } from '@/lib/framework/resparkable/services/group-books';
import { groupBooksQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const query = validateQueryParams(new URL(request.url).searchParams, groupBooksQuerySchema);

  const result = await getGroupBooks(session.user.id, id, query.weeks);
  // A 404 rather than a 403, as on every group route: a 403 confirms the group
  // exists to somebody who guessed an id.
  if (!result.ok) throw new NotFoundError('Group not found');

  log.info('Resparkable group books read', { groupId: id, weeks: query.weeks });

  return successResponse(result.value);
});
