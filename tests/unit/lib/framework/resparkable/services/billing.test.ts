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

const applyLedgerEntry = vi.fn();
const ensureCreditAccount = vi.fn();
const findCreditAccount = vi.fn();
const findResparkableBillingSettings = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  applyLedgerEntry: (...args: unknown[]) => applyLedgerEntry(...args),
  ensureCreditAccount: (...args: unknown[]) => ensureCreditAccount(...args),
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/billing-settings', () => ({
  findResparkableBillingSettings: (...args: unknown[]) => findResparkableBillingSettings(...args),
}));

import { InsufficientCreditsError } from '@/lib/api/errors';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  assertPositiveBalance,
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
  applyLedgerEntry.mockResolvedValue({ id: 'ledger_1' });
});

describe('assertPositiveBalance', () => {
  it('does not throw when the balance is positive', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 5 });

    await expect(assertPositiveBalance(scope)).resolves.toBeUndefined();
  });

  it('throws InsufficientCreditsError at a zero balance', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: 0 });

    await expect(assertPositiveBalance(scope)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('throws InsufficientCreditsError at a negative balance', async () => {
    ensureCreditAccount.mockResolvedValue({ id: 'acct_1', balanceCredits: -2 });

    await expect(assertPositiveBalance(scope)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('lazily backfills the account for a pre-phase-29 space rather than failing', async () => {
    // `ensureCreditAccount` is what does the backfill; this just asserts the
    // pre-flight check goes through it rather than a bare `findCreditAccount`
    // that would throw on a legacy space with no row yet.
    await assertPositiveBalance(scope);

    expect(ensureCreditAccount).toHaveBeenCalledWith(scope);
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

    expect(applyLedgerEntry).toHaveBeenCalledWith(
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

    expect(applyLedgerEntry).toHaveBeenCalledWith(
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
    const entry = applyLedgerEntry.mock.calls[0]?.[1];
    expect(entry.totalUsd).toBeCloseTo(1.1);
    expect(entry.creditsDelta).toBeCloseTo(-110);
  });

  it('does nothing for a zero-cost call, no zero-delta ledger row', async () => {
    const result = await recordAgentSpend(scope, { tokenCostUsd: 0 });

    expect(result).toBeNull();
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });

  it('does nothing for a negative cost either', async () => {
    const result = await recordAgentSpend(scope, { tokenCostUsd: -1 });

    expect(result).toBeNull();
    expect(applyLedgerEntry).not.toHaveBeenCalled();
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
    expect(applyLedgerEntry).not.toHaveBeenCalled();
  });

  it('carries the related-id fields through only when given', async () => {
    await recordAgentSpend(scope, { tokenCostUsd: 1, relatedConversationId: 'conv_1' });

    const entry = applyLedgerEntry.mock.calls[0]?.[1];
    expect(entry.relatedConversationId).toBe('conv_1');
    expect(entry.relatedWorkflowExecutionId).toBeUndefined();
    expect(entry.relatedCostLogId).toBeUndefined();
  });

  it('ensures the account exists before writing, a pre-phase-29 space must not 500', async () => {
    await recordAgentSpend(scope, { tokenCostUsd: 1 });

    expect(ensureCreditAccount).toHaveBeenCalledWith(scope);
  });
});
