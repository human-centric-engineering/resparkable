/**
 * Unit Tests: the group budget's refusals, turned into HTTP errors.
 *
 * The status is the contract the budget screen reads, and `not_a_member` is a
 * 404 on purpose: a 403 would confirm the group exists to somebody who guessed
 * an id.
 *
 * @see lib/framework/resparkable/api/budget-refusal.ts
 */

import { describe, expect, it } from 'vitest';

import { refuseBudget } from '@/lib/framework/resparkable/api/budget-refusal';
import type { BudgetRefusal } from '@/lib/framework/resparkable/services/group-budget';

function statusOf(reason: BudgetRefusal): { status: number; message: string } {
  try {
    refuseBudget(reason);
  } catch (error) {
    const typed = error as { status: number; message: string };
    return { status: typed.status, message: typed.message };
  }
  throw new Error('refuseBudget returned');
}

describe('refuseBudget', () => {
  it.each([
    ['not_a_member', 404],
    ['no_such_member', 404],
    ['not_an_admin', 403],
    ['top_up_not_allowed', 403],
    ['insufficient_personal_credits', 402],
    ['payer_not_admin', 400],
  ] as const)('answers %s with %i', (reason, status) => {
    expect(statusOf(reason).status).toBe(status);
  });

  it('never tells a non-member that the group exists', () => {
    expect(statusOf('not_a_member').message).toBe('Group not found');
  });

  it('says in plain words why a payer was refused', () => {
    expect(statusOf('payer_not_admin').message).toBe(
      'Only an admin of the group can pay its running costs.'
    );
  });
});
