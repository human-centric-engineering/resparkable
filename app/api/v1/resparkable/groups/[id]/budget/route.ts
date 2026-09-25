/**
 * GET   /api/v1/resparkable/groups/[id]/budget: the group's budget.
 * PATCH /api/v1/resparkable/groups/[id]/budget: funding mode and alerts (admin).
 *
 * ## One payload, two audiences
 *
 * Every member gets the balance, the funding mode, whether they may top up, and
 * their own cap and spend against it. Only an admin gets `admin`: the alert
 * settings and per-person spend and contributions. The split is decided in
 * `services/group-budget.ts`, not here, so it cannot drift between routes
 * (§23.12: an admin sees spend, and nobody sees productivity).
 *
 * Keyed on the actor and the group id like every group route; reads no
 * `?space=`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { refuseBudget } from '@/lib/framework/resparkable/api/budget-refusal';
import {
  getGroupBudget,
  updateGroupBudgetSettings,
} from '@/lib/framework/resparkable/services/group-budget';
import { updateGroupBudgetSchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const result = await getGroupBudget(session.user.id, id);
  if (!result.ok) refuseBudget(result.reason);

  log.info('Resparkable group budget read', { groupId: id, admin: result.value.admin !== null });

  return successResponse(result.value);
});

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const body = await validateRequestBody(request, updateGroupBudgetSchema);

  const result = await updateGroupBudgetSettings(session.user.id, id, body);
  if (!result.ok) refuseBudget(result.reason);

  log.info('Resparkable group budget settings changed', {
    groupId: id,
    fields: Object.keys(body),
  });

  return successResponse(result.value);
});
