/**
 * PATCH /api/v1/resparkable/groups/[id]/budget/members/[userId]: set or clear
 * one member's daily credit cap, and (phase 62) their monthly allowance. Admin
 * only.
 *
 * The cap is a blast-radius limit ("a member left a workflow looping
 * overnight"), not a productivity control (§23.12). It is enforced before the
 * provider call, in `assertCanSpend`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { refuseBudget } from '@/lib/framework/resparkable/api/budget-refusal';
import {
  setMemberAllowance,
  setMemberDailyCreditCap,
} from '@/lib/framework/resparkable/services/group-budget';
import { groupMemberCapSchema } from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string; userId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, userId } = await params;

    const body = await validateRequestBody(request, groupMemberCapSchema);

    const value: {
      userId: string;
      dailyCreditCap?: number | null;
      allowanceCredits?: number | null;
    } = { userId };
    if (body.dailyCreditCap !== undefined) {
      const result = await setMemberDailyCreditCap(
        session.user.id,
        id,
        userId,
        body.dailyCreditCap
      );
      if (!result.ok) refuseBudget(result.reason);
      value.dailyCreditCap = result.value.dailyCreditCap;
      log.info('Resparkable group member cap changed', {
        groupId: id,
        capped: body.dailyCreditCap !== null,
      });
    }
    if (body.allowanceCredits !== undefined) {
      const result = await setMemberAllowance(session.user.id, id, userId, body.allowanceCredits);
      if (!result.ok) refuseBudget(result.reason);
      value.allowanceCredits = result.value.allowanceCredits;
      log.info('Resparkable group member allowance changed', {
        groupId: id,
        allowance: body.allowanceCredits !== null,
      });
    }

    return successResponse(value);
  }
);
