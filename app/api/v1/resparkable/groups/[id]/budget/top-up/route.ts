/**
 * POST /api/v1/resparkable/groups/[id]/budget/top-up: move credits from your
 * own balance into the group's.
 *
 * `to: 'me'` (phase 62) fills your own balance in the group instead: the money
 * you spend there under a filled allowance or an equal split, and pay a seat
 * from. Any joined member may, and it comes back to you when you leave.
 *
 * An admin always may; a member when the group takes member contributions; a
 * viewer never (§23.12, amended 2026-09-25). The credits come out of the
 * caller's personal balance and nobody else's, and a balance that does not
 * cover the amount is a 402 with nothing written.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { refuseBudget } from '@/lib/framework/resparkable/api/budget-refusal';
import {
  topUpGroup,
  topUpOwnGroupBalance,
} from '@/lib/framework/resparkable/services/group-budget';
import { groupTopUpSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, groupTopUpSchema);

  if (body.to === 'me') {
    const own = await topUpOwnGroupBalance(session.user.id, id, body.credits);
    if (!own.ok) refuseBudget(own.reason);
    log.info('Resparkable group top-up', { groupId: id, credits: body.credits, to: 'me' });
    return successResponse(own.value);
  }

  const result = await topUpGroup(session.user.id, id, body.credits);
  if (!result.ok) refuseBudget(result.reason);

  log.info('Resparkable group top-up', { groupId: id, credits: body.credits, to: 'pool' });

  return successResponse(result.value);
});
