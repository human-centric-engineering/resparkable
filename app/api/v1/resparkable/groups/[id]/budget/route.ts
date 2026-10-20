/**
 * GET   /api/v1/resparkable/groups/[id]/budget: the group's budget.
 * PATCH /api/v1/resparkable/groups/[id]/budget: funding mode, alerts, and who
 *   pays (admin). A change to who pays waits for the start of the group's next
 *   month (phase 62).
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
  updateGroupBilling,
  updateGroupBudgetSettings,
  type GroupBillingChange,
} from '@/lib/framework/resparkable/services/group-budget';
import {
  GROUP_BILLING_FIELDS,
  updateGroupBudgetSchema,
} from '@/lib/framework/resparkable/validations';

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
  const { fundingMode, lowBalanceAlertCredits, largeRunAlertPercent, discardPendingBilling } = body;

  // Two halves with different timing: funding mode and alerts change now, who
  // pays changes next month. Billing first, so a refused payer writes nothing.
  const billing: GroupBillingChange = {};
  for (const field of GROUP_BILLING_FIELDS) {
    if (body[field] !== undefined) Object.assign(billing, { [field]: body[field] });
  }
  let billingView = null;
  if (Object.keys(billing).length > 0 || discardPendingBilling) {
    const changed = await updateGroupBilling(session.user.id, id, billing, {
      discardPending: discardPendingBilling === true,
    });
    if (!changed.ok) refuseBudget(changed.reason);
    billingView = changed.value;
  }

  const budget = { fundingMode, lowBalanceAlertCredits, largeRunAlertPercent };
  const budgetFields = Object.fromEntries(
    Object.entries(budget).filter(([, value]) => value !== undefined)
  );
  let budgetView = null;
  if (Object.keys(budgetFields).length > 0) {
    const result = await updateGroupBudgetSettings(session.user.id, id, budgetFields);
    if (!result.ok) refuseBudget(result.reason);
    budgetView = result.value;
  }

  log.info('Resparkable group budget settings changed', {
    groupId: id,
    fields: Object.keys(body),
  });

  return successResponse({ ...budgetView, ...(billingView ? { billing: billingView } : {}) });
});
