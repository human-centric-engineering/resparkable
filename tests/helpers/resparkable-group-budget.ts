/**
 * Fixtures for the group budget and books wire payloads (phase 62).
 *
 * One place that knows what a default group looks like (the pool pays, nothing
 * is charged for places), so a change to the payload shape is one edit here
 * rather than one per test file.
 */

import type {
  GroupBillingSettingsWire,
  GroupBooksFiguresWire,
  GroupBooksWire,
  GroupBudgetWire,
} from '@/lib/framework/resparkable/ui/payloads';

export const POOL_SETTINGS: GroupBillingSettingsWire = {
  seatPriceAdminCredits: 0,
  seatPriceMemberCredits: 0,
  seatPriceViewerCredits: 0,
  operationalCostsPaidBy: 'pool',
  operationalPayerUserId: null,
  activityCostsPaidBy: 'pool',
  allowanceSource: 'carved',
  shortfallPolicy: 'debt',
};

export function makeYou(overrides: Partial<GroupBudgetWire['you']> = {}): GroupBudgetWire['you'] {
  return {
    dailyCreditCap: null,
    spentLastDayCredits: 0,
    balanceCredits: 0,
    allowanceCredits: null,
    allowanceRemainingCredits: 0,
    autoTopUpMonthlyCredits: null,
    autoTopUpUsedThisMonthCredits: 0,
    suspended: false,
    ...overrides,
  };
}

export function makeBilling(
  overrides: Partial<GroupBudgetWire['billing']> = {}
): GroupBudgetWire['billing'] {
  return {
    settings: POOL_SETTINGS,
    pending: null,
    monthStartedAt: '2026-10-05T00:00:00.000Z',
    nextMonthStartsAt: '2026-11-05T00:00:00.000Z',
    timeZone: 'UTC',
    operationalPayerName: null,
    ...overrides,
  };
}

export function makeBudget(overrides: Partial<GroupBudgetWire> = {}): GroupBudgetWire {
  return {
    balanceCredits: 40,
    fundingMode: 'self_funded',
    canTopUp: true,
    yourPersonalBalanceCredits: 10,
    you: makeYou(),
    billing: makeBilling(),
    admin: null,
    ...overrides,
  };
}

export function makeFigures(overrides: Partial<GroupBooksFiguresWire> = {}): GroupBooksFiguresWire {
  return {
    seats: 0,
    runningCosts: 0,
    sharedActivity: 0,
    ownActivity: 0,
    topUps: 0,
    creditedBack: 0,
    debtsTakenOn: 0,
    ...overrides,
  };
}

export function makeBooks(overrides: Partial<GroupBooksWire> = {}): GroupBooksWire {
  return {
    timeZone: 'UTC',
    poolBalanceCredits: 0,
    weeks: [],
    totals: makeFigures(),
    people: [],
    ...overrides,
  };
}
