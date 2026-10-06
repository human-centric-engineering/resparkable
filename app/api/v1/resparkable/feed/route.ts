/**
 * `GET /api/v1/resparkable/feed`: the group activity feed for the current
 * workspace (§23.10, phase 59). A personal workspace is a 404.
 *
 * Polled, never pushed: the client sends `If-None-Match`, and an unchanged
 * page is a 304 with no body, so thirty open laptops cost thirty cheap
 * queries rather than thirty held connections.
 *
 * @see lib/framework/resparkable/services/feed.ts
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { buildFeed, decodeFeedCursor } from '@/lib/framework/resparkable/services/feed';
import { feedQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);
  const query = validateQueryParams(new URL(request.url).searchParams, feedQuerySchema);

  const before = query.before ? decodeFeedCursor(query.before) : null;
  if (query.before && !before) {
    throw new ValidationError('Invalid cursor', { before: ['Not a feed position'] });
  }

  const page = await buildFeed(scope, {
    ...(before ? { before } : {}),
    ...(query.member ? { memberUserId: query.member } : {}),
  });
  if (!page) throw new NotFoundError('There is no activity feed in a personal workspace');

  const etag = computeETag(page);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  // A count of lines on the page and nothing about who: the log is not where
  // a tally over members gets started.
  log.info('Resparkable feed read', { count: page.items.length });

  return successResponse(page, undefined, { headers: { ETag: etag } });
});
