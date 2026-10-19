/**
 * PATCH /api/v1/resparkable/groups/[id]/budget/me: the caller's own automatic
 * top-up in a group (phase 62).
 *
 * The most that may move from the caller's own credits into their balance in
 * the group in a month, when that balance runs out. Only ever the caller's own:
 * it is a standing instruction to move their money, so nobody else, an admin
 * included, can set it for them. `null` withdraws it.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { refuseBudget } from '@/lib/framework/resparkable/api/budget-refusal';
import { setOwnAutoTopUp } from '@/lib/framework/resparkable/services/group-budget';
import { groupOwnBudgetSchema } from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, groupOwnBudgetSchema);

  const result = await setOwnAutoTopUp(session.user.id, id, body.autoTopUpMonthlyCredits);
  if (!result.ok) refuseBudget(result.reason);

  log.info('Resparkable group automatic top-up changed', {
    groupId: id,
    on: body.autoTopUpMonthlyCredits !== null,
  });

  return successResponse(result.value);
});
