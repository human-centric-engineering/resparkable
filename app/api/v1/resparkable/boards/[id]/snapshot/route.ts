/**
 * POST /api/v1/resparkable/boards/[id]/snapshot — freeze a filter board.
 *
 * §13's third required mitigation for the dynamic-filter trap, and the only one
 * of the three that is a mechanism rather than a warning.
 *
 * A board with `membership: 'filter'` is a live query. Sharing it does not
 * share a fixed set of cards — it shares **every task matching the filter,
 * including ones created next Tuesday**, with no further gesture from the owner.
 * That is what people expect from "share my board", and it is also a standing
 * leak. This flips the board to `membership: 'explicit'` and pins exactly the
 * cards it shows right now, so what was shared stops changing.
 *
 * **It is not reversible from here, and that is deliberate.** Flipping back to
 * a filter is an edit to the board (`PATCH /boards/[id]`), where it reads as
 * what it is: a decision to start sharing future tasks again.
 *
 * Already-explicit boards 404. A board somebody has curated by hand must not be
 * re-pinned from a filter that no longer describes it, which would throw their
 * arrangement away for a snapshot they did not ask for.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { snapshotBoard } from '@/lib/framework/resparkable/services/board-view';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = spaceScope(session.user.id);
  const { id } = await params;

  const view = await snapshotBoard(scope, id);
  if (!view) throw new NotFoundError('Board not found');

  log.info('Resparkable board snapshotted', { id, cards: view.totalCards });

  return successResponse(view);
});
