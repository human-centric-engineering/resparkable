/**
 * Unit Tests: the billing service (Phase 29), the pre-flight balance check
 * and the spend-recording math shared by all three attribution sites.
 *
 * Two properties matter most:
 *
 * **The debit always reflects real usage, never the estimate that gated the
 * pre-flight check** (§16.6 risk 20a in the plan doc): `recordAgentSpend`
 * takes `tokenCostUsd` as given and computes the service charge from it,
 * with no reference to whatever balance check happened earlier.
 *
 * **A zero-cost call writes nothing.** ideate's no-connections early return
 * and any other zero-`costUsd` path must not leave a zero-delta ledger row,
 * that would be noise in a place people expect an explanation for every line.
 *
 * @see lib/framework/resparkable/services/billing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyLedgerEntryWithBalance = vi.fn();
const ensureCreditAccount = vi.fn();
const findCreditAccount = vi.fn();
const findResparkableBillingSettings = vi.fn();
const sumMemberSpendSince = vi.fn();
const findMembershipBySpace = vi.fn();

// `after()` needs a request scope. By default it throws here, as it does in
// the queue tick, so the alert runs in the background; tests that need the
// request path swap in an implementation that records the task.
const after = vi.fn((_task: () => Promise<unknown>): void => {
  throw new Error('after() was called outside a request scope');
});
vi.mock('next/server', () => ({ after: (task: () => Promise<unknown>) => after(task) }));
vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  applyLedgerEntryWithBalance: (...args: unknown[]) => applyLedgerEntryWithBalance(...args),
  ensureCreditAccount: (...args: unknown[]) => ensureCreditAccount(...args),
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
  sumMemberSpendSince: (...args: unknown[]) => sumMemberSpendSince(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findMembershipBySpace: (...args: unknown[]) => findMembershipBySpace(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/billing-settings', () => ({
  findResparkableBillingSettings: (...args: unknown[]) => findResparkableBillingSettings(...args),
}));
const notifyGroupBudgetThresholds = vi.fn();
vi.mock('@/lib/framework/resparkable/services/group-budget', () => ({
  notifyGroupBudgetThresholds: (...args: unknown[]) => notifyGroupBudgetThresholds(...args),
  // The real window, so the cap tests measure what the pre-flight measures.
  DAILY_CAP_WINDOW_MS: 24 * 60 * 60_000,
}));

import { ForbiddenError, InsufficientCreditsError } from '@/lib/api/errors';
import { spaceScope, spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  DailyCreditCapError,
  assertCanSpend,
  hasPositiveBalance,
  recordAgentSpend,
} from '@/lib/framework/resparkable/services/billing';

const scope = spaceScope('user_a');

function billingSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings_1',
    slug: 'global',
    creditsPerUsd: 1,
    serviceChargePercent: 0,
    costVisibleToUsersDefault: true,
    currencyLabel: 'credits',
    newUserGrantCredits: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findResparkableBillingSettings.mockResolvedValue(null); // → DEFAULT_BILLING_SETTINGS
  ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 10 });
  applyLedgerEntryWithBalance.mockResolvedValue({ entry: { id: 'ledger_1' }, balanceAfter: 8 });
  notifyGroupBudgetThresholds.mockResolvedValue({ sent: [] });
});

describe('assertCanSpend', () => {
  it('does not throw when the balance is positive', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 5 });

    await expect(assertCanSpend(scope)).resolves.toBeUndefined();
  });

  it('throws InsufficientCreditsError at a zero balance', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 0 });

    await expect(assertCanSpend(scope)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('throws InsufficientCreditsError at a negative balance', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: -2 });

    await expect(assertCanSpend(scope)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('lazily backfills the account for a pre-phase-29 space rather than failing', async () => {
    // `ensureCreditAccount` is what does the backfill; this just asserts the
    // pre-flight check goes through it rather than a bare `findCreditAccount`
    // that would throw on a legacy space with no row yet.
    await assertCanSpend(scope);

    expect(ensureCreditAccount).toHaveBeenCalledWith(scope);
  });
});

/**
 * Test 13k at the pre-flight (§23.12, phase 50): the budget refuses before it
 * spends. Each refusal is asserted by what the pre-flight did NOT touch as well
 * as by what it threw, because "refused" and "refused, having quietly read
 * somebody's personal account on the way" look identical from the error alone.
 */
describe('assertCanSpend in a group space (test 13k)', () => {
  const groupScope = (role: 'admin' | 'member' | 'viewer') =>
    spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role });

  beforeEach(() => {
    findMembershipBySpace.mockResolvedValue({ dailyCreditCap: null });
    sumMemberSpendSince.mockResolvedValue(0);
  });

  it('refuses an empty group balance and never looks at the member’s own account', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_group', balanceCredits: 0 });

    const refusal = assertCanSpend(groupScope('member'));

    await expect(refusal).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(refusal).rejects.toThrow(/group admin can top it up/);
    // Exactly one account, and it is the group's. A second lookup, of any
    // scope, is the shape the fallback to a personal balance would take.
    expect(ensureCreditAccount).toHaveBeenCalledTimes(1);
    expect(ensureCreditAccount.mock.calls[0]?.[0]).toMatchObject({ spaceId: 'spc_group' });
    expect(findCreditAccount).not.toHaveBeenCalled();
  });

  it('refuses a viewer outright, even with a full balance, without reading one', async () => {
    // Zero, not a small cap. A viewer has no write capability, and every billed
    // action in the tier is a write or produces one.
    await expect(assertCanSpend(groupScope('viewer'))).rejects.toBeInstanceOf(ForbiddenError);
    expect(ensureCreditAccount).not.toHaveBeenCalled();
  });

  it('refuses a grantee viewer on somebody else’s personal space the same way', async () => {
    const grantee = spaceScopeFor({ spaceId: 'user_owner', actorUserId: 'user_g', role: 'viewer' });
    await expect(assertCanSpend(grantee)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a member who has reached their daily cap', async () => {
    findMembershipBySpace.mockResolvedValue({ dailyCreditCap: 5 });
    sumMemberSpendSince.mockResolvedValue(5);

    await expect(assertCanSpend(groupScope('member'))).rejects.toBeInstanceOf(DailyCreditCapError);
    // Measured over the member's own spend in this space, over a rolling day.
    const [scopeArg, memberArg, since] = sumMemberSpendSince.mock.calls[0] ?? [];
    expect(scopeArg).toMatchObject({ spaceId: 'spc_group' });
    expect(memberArg).toBe('user_m');
    const windowMs = Date.now() - (since as Date).getTime();
    expect(windowMs).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000);
    expect(windowMs).toBeLessThanOrEqual(24 * 60 * 60_000 + 1000);
  });

  it('lets a member under their cap through', async () => {
    findMembershipBySpace.mockResolvedValue({ dailyCreditCap: 5 });
    sumMemberSpendSince.mockResolvedValue(4.99);

    await expect(assertCanSpend(groupScope('member'))).resolves.toBeUndefined();
  });

  it('caps an admin like anyone else: the cap is blast radius, not rank', async () => {
    findMembershipBySpace.mockResolvedValue({ dailyCreditCap: 1 });
    sumMemberSpendSince.mockResolvedValue(2);

    await expect(assertCanSpend(groupScope('admin'))).rejects.toBeInstanceOf(DailyCreditCapError);
  });

  it('sums nothing for an uncapped member, which is the default', async () => {
    await expect(assertCanSpend(groupScope('member'))).resolves.toBeUndefined();
    expect(sumMemberSpendSince).not.toHaveBeenCalled();
  });

  it('never consults membership in a personal space', async () => {
    await expect(assertCanSpend(scope)).resolves.toBeUndefined();
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });
});

describe('hasPositiveBalance', () => {
  it('is true at a positive balance', async () => {
    findCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 1 });

    await expect(hasPositiveBalance(scope)).resolves.toBe(true);
  });

  it('is false when no account exists yet, without creating one', async () => {
    findCreditAccount.mockResolvedValue(null);

    await expect(hasPositiveBalance(scope)).resolves.toBe(false);
    expect(ensureCreditAccount).not.toHaveBeenCalled();
  });

  it('is false at a zero or negative balance', async () => {
    findCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: -1 });

    await expect(hasPositiveBalance(scope)).resolves.toBe(false);
  });
});

describe('recordAgentSpend', () => {
  it('debits credits 1:1 with tokenCostUsd under the default settings', async () => {
    await recordAgentSpend(scope, { tokenCostUsd: 2 });

    expect(applyLedgerEntryWithBalance).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        kind: 'agent_spend',
        tokenCostUsd: 2,
        serviceChargeUsd: 0,
        totalUsd: 2,
        creditsDelta: -2,
      })
    );
  });

  it('adds the configured service charge before converting to credits', async () => {
    findResparkableBillingSettings.mockResolvedValue(billingSettings({ serviceChargePercent: 20 }));

    await recordAgentSpend(scope, { tokenCostUsd: 10 });

    expect(applyLedgerEntryWithBalance).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ serviceChargeUsd: 2, totalUsd: 12, creditsDelta: -12 })
    );
  });

  it('applies creditsPerUsd on top of the service charge, not instead of it', async () => {
    findResparkableBillingSettings.mockResolvedValue(
      billingSettings({ serviceChargePercent: 10, creditsPerUsd: 100 })
    );

    await recordAgentSpend(scope, { tokenCostUsd: 1 });

    // $1 + 10% = $1.10 total, at 100 credits/$ = 110 credits debited.
    const entry = applyLedgerEntryWithBalance.mock.calls[0]?.[1];
    expect(entry.totalUsd).toBeCloseTo(1.1);
    expect(entry.creditsDelta).toBeCloseTo(-110);
  });

  it('does nothing for a zero-cost call, no zero-delta ledger row', async () => {
    const result = await recordAgentSpend(scope, { tokenCostUsd: 0 });

    expect(result).toBeNull();
    expect(applyLedgerEntryWithBalance).not.toHaveBeenCalled();
  });

  it('does nothing for a negative cost either', async () => {
    const result = await recordAgentSpend(scope, { tokenCostUsd: -1 });

    expect(result).toBeNull();
    expect(applyLedgerEntryWithBalance).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION. `NaN <= 0` is `false`, so a bare `tokenCostUsd <= 0` guard
   * lets a NaN cost (an unmapped model in the provider cost table, say) fall
   * through into the ledger math and reach `balanceCredits: { increment: NaN }` —
   * corrupting the account's stored balance, not just this one write.
   */
  it('does nothing for a NaN cost either', async () => {
    const result = await recordAgentSpend(scope, { tokenCostUsd: NaN });

    expect(result).toBeNull();
    expect(applyLedgerEntryWithBalance).not.toHaveBeenCalled();
  });

  it('carries the related-id fields through only when given', async () => {
    await recordAgentSpend(scope, { tokenCostUsd: 1, relatedConversationId: 'conv_1' });

    const entry = applyLedgerEntryWithBalance.mock.calls[0]?.[1];
    expect(entry.relatedConversationId).toBe('conv_1');
    expect(entry.relatedWorkflowExecutionId).toBeUndefined();
    expect(entry.relatedCostLogId).toBeUndefined();
  });

  it('ensures the account exists before writing, a pre-phase-29 space must not 500', async () => {
    await recordAgentSpend(scope, { tokenCostUsd: 1 });

    expect(ensureCreditAccount).toHaveBeenCalledWith(scope);
  });

  describe('the group budget alert (phase 50)', () => {
    const groupScope = spaceScopeFor({
      spaceId: 'spc_group',
      actorUserId: 'user_m',
      role: 'member',
    });

    it('notifies for a non-owner scope with the balance before and after the debit', async () => {
      // $2 at the default settings (0% charge, 1 credit/$) debits 2 credits, so
      // a balanceAfter of 8 from the UPDATE means the balance stood at 10
      // before it.
      applyLedgerEntryWithBalance.mockResolvedValue({ entry: { id: 'ledger_1' }, balanceAfter: 8 });

      await recordAgentSpend(groupScope, { tokenCostUsd: 2 });

      expect(notifyGroupBudgetThresholds).toHaveBeenCalledWith(groupScope, {
        before: 10,
        after: 8,
      });
    });

    it('two concurrent debits each report their own step, from their own balanceAfter', async () => {
      // Reading the balance from anywhere but each write's own UPDATE lets two
      // concurrent debits both see the same "before", so a crossing is
      // reported twice or not at all.
      applyLedgerEntryWithBalance
        .mockResolvedValueOnce({ entry: { id: 'ledger_1' }, balanceAfter: 8 })
        .mockResolvedValueOnce({ entry: { id: 'ledger_2' }, balanceAfter: 6 });

      await Promise.all([
        recordAgentSpend(groupScope, { tokenCostUsd: 2 }),
        recordAgentSpend(groupScope, { tokenCostUsd: 2 }),
      ]);

      const steps = notifyGroupBudgetThresholds.mock.calls.map((call) => call[1]);
      expect(steps).toHaveLength(2);
      expect(steps).toEqual(
        expect.arrayContaining([
          { before: 10, after: 8 },
          { before: 8, after: 6 },
        ])
      );
    });

    it('is not called for an owner scope', async () => {
      await recordAgentSpend(scope, { tokenCostUsd: 2 });

      expect(notifyGroupBudgetThresholds).not.toHaveBeenCalled();
    });

    it('is not called for a zero-cost call that writes nothing', async () => {
      ensureCreditAccount.mockClear();

      await recordAgentSpend(groupScope, { tokenCostUsd: 0 });

      expect(notifyGroupBudgetThresholds).not.toHaveBeenCalled();
      expect(ensureCreditAccount).not.toHaveBeenCalled();
    });

    it('runs the alert after the ledger write, not before it', async () => {
      const order: string[] = [];
      applyLedgerEntryWithBalance.mockImplementation(async () => {
        order.push('applyLedgerEntryWithBalance');
        return { entry: { id: 'ledger_1' }, balanceAfter: 8 };
      });
      notifyGroupBudgetThresholds.mockImplementation(async () => {
        order.push('notifyGroupBudgetThresholds');
        return { sent: [] };
      });

      await recordAgentSpend(groupScope, { tokenCostUsd: 2 });

      expect(order).toEqual(['applyLedgerEntryWithBalance', 'notifyGroupBudgetThresholds']);
    });

    it('hands the alert to after() on a request path, so the host keeps it alive', async () => {
      const scheduled: Array<() => Promise<unknown>> = [];
      after.mockImplementationOnce((task) => {
        scheduled.push(task);
      });

      await recordAgentSpend(groupScope, { tokenCostUsd: 2 });

      // Scheduled, not yet run: the response goes first.
      expect(scheduled).toHaveLength(1);
      expect(notifyGroupBudgetThresholds).not.toHaveBeenCalled();
      await scheduled[0]?.();
      expect(notifyGroupBudgetThresholds).toHaveBeenCalledTimes(1);
    });

    it('waits for the alert when the caller asks, as the billing pass does', async () => {
      let finished = false;
      notifyGroupBudgetThresholds.mockImplementation(async () => {
        await Promise.resolve();
        finished = true;
        return { sent: [] };
      });

      await recordAgentSpend(groupScope, { tokenCostUsd: 2, awaitAlerts: true });

      expect(finished).toBe(true);
      expect(after).not.toHaveBeenCalled();
    });

    it('does not make the debit wait on the alert emails', async () => {
      // The chat stream awaits this before its "done" event, so an alert still
      // sending must not hold the member's turn open.
      notifyGroupBudgetThresholds.mockImplementation(() => new Promise(() => undefined));

      await expect(recordAgentSpend(groupScope, { tokenCostUsd: 2 })).resolves.toEqual({
        id: 'ledger_1',
      });
    });
  });
});
