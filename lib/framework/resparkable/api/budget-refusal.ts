/**
 * The group budget's refusals, turned into HTTP errors in one place for its
 * three routes (`groups/[id]/budget/**`).
 *
 * `not_a_member` is a 404 rather than a 403, as on every group route: a 403
 * confirms the group exists to somebody who guessed an id. The two money
 * refusals are 402 and 403 with messages the budget screen shows as they are.
 */

import { ForbiddenError, InsufficientCreditsError, NotFoundError } from '@/lib/api/errors';
import type { BudgetRefusal } from '@/lib/framework/resparkable/services/group-budget';

export function refuseBudget(reason: BudgetRefusal): never {
  switch (reason) {
    case 'not_a_member':
      throw new NotFoundError('Group not found');
    case 'no_such_member':
      throw new NotFoundError('That person is not in this group');
    case 'not_an_admin':
      throw new ForbiddenError('Only an admin can do that');
    case 'top_up_not_allowed':
      throw new ForbiddenError(
        'In this group only admins add credits. An admin can let members add them too.'
      );
    case 'insufficient_personal_credits':
      throw new InsufficientCreditsError('You do not have that many credits of your own to add.');
  }
}
