/**
 * POST /api/v1/resparkable/reviews/[id]/dismiss — archive a proposal.
 *
 * Archives rather than deletes (`services/reviews.ts#dismissReview`) — the row
 * stays reachable at `?includeArchived=true` and in GDPR export, it just stops
 * showing up. Introduced for the Release 8 `context_summary` reject action, but
 * generic to any review.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { dismissReview } from '@/lib/framework/resparkable/services/reviews';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);
  const { id } = await params;

  const review = await dismissReview(scope, id);
  if (!review) throw new NotFoundError('Review not found');

  log.info('Resparkable review dismissed', { id, horizon: review.horizon });

  return successResponse(review);
});
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
