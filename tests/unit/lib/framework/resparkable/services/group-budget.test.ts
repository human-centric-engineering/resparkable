/**
 * Unit Tests: the group budget service (§23.12, phase 50).
 *
 * Four properties matter most:
 *
 * **Only an admin gets the admin controls.** A member's `admin` is `null`, and
 * the admin-only read (`listGroupMembers`) is never called on their path, not
 * merely hidden from the result. Per-person spend is in the books (phase 62),
 * which every member reads.
 *
 * **A pending member never appears in the admin's table.** The admin view
 * filters `joinedAt !== null` before mapping.
 *
 * **A top-up moves money from the giver's own space to the group's, never any
 * other pairing**, and is refused for the roles the funding mode says may not.
 *
 * **The two budget alerts fire on a crossing, not on "already below"**, are
 * admin-only, off when unset, and never throw even when sending fails.
 *
 * @see lib/framework/resparkable/services/group-budget.ts
 */

import { render } from '@react-email/render';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findCreditAccount = vi.fn();
const sumMemberSpendSince = vi.fn();
const transferCreditsToGroup = vi.fn();
const ensureCreditAccount = vi.fn();

const findGroupBySpaceId = vi.fn();
const findGroupById = vi.fn();
const listGroupMembers = vi.fn();
const findAccountNames = vi.fn();
const listMemberContacts = vi.fn();
const updateGroup = vi.fn();
const updateMemberDailyCreditCap = vi.fn();
const claimLargeRunAlert = vi.fn();
const releaseLargeRunAlert = vi.fn();

const sendEmail = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
  sumMemberSpendSince: (...args: unknown[]) => sumMemberSpendSince(...args),
  transferCreditsToGroup: (...args: unknown[]) => transferCreditsToGroup(...args),
  ensureCreditAccount: (...args: unknown[]) => ensureCreditAccount(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findGroupBySpaceId: (...args: unknown[]) => findGroupBySpaceId(...args),
  findGroupById: (...args: unknown[]) => findGroupById(...args),
  listGroupMembers: (...args: unknown[]) => listGroupMembers(...args),
  findAccountNames: (...args: unknown[]) => findAccountNames(...args),
  listMemberContacts: (...args: unknown[]) => listMemberContacts(...args),
  updateGroup: (...args: unknown[]) => updateGroup(...args),
  updateMemberDailyCreditCap: (...args: unknown[]) => updateMemberDailyCreditCap(...args),
  claimLargeRunAlert: (...args: unknown[]) => claimLargeRunAlert(...args),
  releaseLargeRunAlert: (...args: unknown[]) => releaseLargeRunAlert(...args),
}));
const findGroupWithClockBySpaceId = vi.fn();
const findJoinedMembership = vi.fn();
vi.mock('@/lib/framework/resparkable/repo/group-billing', () => ({
  findGroupWithClockBySpaceId: (...args: unknown[]) => findGroupWithClockBySpaceId(...args),
  findJoinedMembership: (...args: unknown[]) => findJoinedMembership(...args),
}));
const promotePendingBilling = vi.fn();
const setPendingBilling = vi.fn();
const clearPendingBilling = vi.fn();
const updateMemberAllowance = vi.fn();
const updateMemberAutoTopUp = vi.fn();
const transferCreditsToMemberBalance = vi.fn();
const releaseOperationalPayer = vi.fn();
vi.mock('@/lib/framework/resparkable/repo/group-billing-settings', () => ({
  promotePendingBilling: (...args: unknown[]) => promotePendingBilling(...args),
  setPendingBilling: (...args: unknown[]) => setPendingBilling(...args),
  clearPendingBilling: (...args: unknown[]) => clearPendingBilling(...args),
  updateMemberAllowance: (...args: unknown[]) => updateMemberAllowance(...args),
  updateMemberAutoTopUp: (...args: unknown[]) => updateMemberAutoTopUp(...args),
  transferCreditsToMemberBalance: (...args: unknown[]) => transferCreditsToMemberBalance(...args),
  releaseOperationalPayer: (...args: unknown[]) => releaseOperationalPayer(...args),
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
const ensureResparkableSpace = vi.fn().mockResolvedValue({});
vi.mock('@/lib/framework/resparkable/services/space', () => ({
  ensureResparkableSpace: (...args: unknown[]) => ensureResparkableSpace(...args),
}));

const recordGroupAudit = vi.fn();
vi.mock('@/lib/framework/resparkable/services/group-audit', () => ({
  recordGroupAudit: (...args: unknown[]) => recordGroupAudit(...args),
}));

const resolveGroupMembership = vi.fn();
vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => {
  // `permissionsFor` stays real: it is pure role-to-permission logic, not a
  // boundary, and mocking it too would make every admin/member assertion
  // below just re-check whatever this file typed into a stub.
  const actual =
    await importOriginal<typeof import('@/lib/framework/resparkable/services/membership')>();
  return {
    ...actual,
    resolveGroupMembership: (...args: unknown[]) => resolveGroupMembership(...args),
  };
});

import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  getGroupBudget,
  notifyGroupBudgetThresholds,
  releasePayerAndTell,
  setMemberAllowance,
  setMemberDailyCreditCap,
  setOwnAutoTopUp,
  topUpGroup,
  topUpOwnGroupBalance,
  updateGroupBilling,
  updateGroupBudgetSettings,
} from '@/lib/framework/resparkable/services/group-budget';

const GROUP = {
  id: 'grp_1',
  name: 'Study Group B',
  spaceId: 'spc_group',
  createdAt: new Date('2026-09-05T10:00:00Z'),
  fundingMode: 'self_funded',
  lowBalanceAlertCredits: null as number | null,
  largeRunAlertPercent: null as number | null,
  // Phase 62's who-pays settings, at their defaults (the pool pays).
  seatPriceAdminCredits: 0,
  seatPriceMemberCredits: 0,
  seatPriceViewerCredits: 0,
  operationalCostsPaidBy: 'pool',
  operationalPayerUserId: null as string | null,
  activityCostsPaidBy: 'pool',
  allowanceSource: 'carved',
  shortfallPolicy: 'debt',
  pendingBilling: null as unknown,
  pendingBillingFrom: null as Date | null,
};

function membershipRow(role: 'admin' | 'member' | 'viewer', dailyCreditCap: number | null = null) {
  return {
    membership: {
      group: GROUP,
      dailyCreditCap,
      balanceCredits: 0,
      allowanceCredits: null,
      allowanceRemainingCredits: 0,
      autoTopUpMonthlyCredits: null,
      autoTopUpUsedCredits: 0,
      autoTopUpMonth: null,
    },
    scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findCreditAccount.mockResolvedValue(null);
  findAccountNames.mockResolvedValue(new Map());
  sumMemberSpendSince.mockResolvedValue(0);
  findGroupWithClockBySpaceId.mockResolvedValue({ ...GROUP, timezone: 'UTC' });
});

describe('getGroupBudget', () => {
  it('is not_a_member for a caller resolveGroupMembership does not recognise', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    const result = await getGroupBudget('user_x', 'grp_1');

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
  });

  it('gives a member admin: null and never reads the admin-only queries', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('member'));
    findCreditAccount.mockResolvedValue({ balanceCredits: 40 });

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.admin).toBeNull();
    // Not merely hidden from the payload: never fetched at all, so a member's
    // browser cannot receive it even by a serialisation slip further up.
    expect(listGroupMembers).not.toHaveBeenCalled();
  });

  it('gives an admin each joined member by name, with the two limits and no money', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    findCreditAccount.mockResolvedValue({ balanceCredits: 100 });
    listGroupMembers.mockResolvedValue([
      {
        userId: 'user_a',
        role: 'admin',
        dailyCreditCap: null,
        allowanceCredits: 40,
        joinedAt: new Date('2026-01-01'),
      },
      {
        userId: 'user_b',
        role: 'member',
        dailyCreditCap: 5,
        allowanceCredits: null,
        joinedAt: new Date('2026-01-02'),
      },
    ]);
    // user_b has an account with no name set.
    findAccountNames.mockResolvedValue(
      new Map([
        ['user_a', 'Ada Lovelace'],
        ['user_b', null],
      ])
    );

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Exactly these keys: spend and contributions moved to the books, so an
    // admin's list carries nothing a member could not already read.
    expect(result.value.admin?.members).toEqual([
      {
        userId: 'user_a',
        name: 'Ada Lovelace',
        role: 'admin',
        dailyCreditCap: null,
        allowanceCredits: 40,
      },
      {
        userId: 'user_b',
        name: null,
        role: 'member',
        dailyCreditCap: 5,
        allowanceCredits: null,
      },
    ]);
  });

  it('excludes a pending member from the admin table', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    findCreditAccount.mockResolvedValue({ balanceCredits: 100 });
    listGroupMembers.mockResolvedValue([
      { userId: 'user_a', role: 'admin', dailyCreditCap: null, joinedAt: new Date('2026-01-01') },
      { userId: 'user_pending', role: 'member', dailyCreditCap: null, joinedAt: null },
    ]);

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.admin?.members.map((m) => m.userId)).toEqual(['user_a']);
    // A pending member's name is not looked up either.
    expect(findAccountNames).toHaveBeenCalledWith(['user_a']);
  });

  it.each([
    ['admin', 'self_funded', true],
    ['member', 'self_funded', false],
    ['viewer', 'self_funded', false],
    ['admin', 'member_contributions', true],
    ['member', 'member_contributions', true],
    ['viewer', 'member_contributions', false],
  ] as const)('canTopUp is %s for a %s under %s', async (role, fundingMode, expected) => {
    resolveGroupMembership.mockResolvedValue({
      membership: { group: { ...GROUP, fundingMode }, dailyCreditCap: null },
      scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role }),
    });

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.canTopUp).toBe(expected);
  });

  it('carries the caller’s own cap and their spend against it in the last 24 hours', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('member', 7));
    sumMemberSpendSince.mockResolvedValue(2.456);

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.you).toMatchObject({ dailyCreditCap: 7, spentLastDayCredits: 2.46 });
    // Measured over a rolling day, not a calendar one.
    const [, memberArg, since] = sumMemberSpendSince.mock.calls[0] ?? [];
    expect(memberArg).toBe('user_m');
    const windowMs = Date.now() - (since as Date).getTime();
    expect(windowMs).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000);
    expect(windowMs).toBeLessThanOrEqual(24 * 60 * 60_000 + 1000);
  });
});

describe('updateGroupBudgetSettings', () => {
  it('refuses a non-admin without writing', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('member'));

    const result = await updateGroupBudgetSettings('user_m', 'grp_1', {
      fundingMode: 'self_funded',
    });

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it('is not_a_member for a caller with no resolvable membership', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    const result = await updateGroupBudgetSettings('user_x', 'grp_1', {
      fundingMode: 'self_funded',
    });

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
  });

  it('lets an admin write through updateGroup and returns the new settings', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateGroup.mockResolvedValue({
      fundingMode: 'member_contributions',
      lowBalanceAlertCredits: 20,
      largeRunAlertPercent: 50,
    });

    const result = await updateGroupBudgetSettings('user_m', 'grp_1', {
      fundingMode: 'member_contributions',
    });

    expect(updateGroup).toHaveBeenCalledWith('grp_1', { fundingMode: 'member_contributions' });
    expect(result).toEqual({
      ok: true,
      value: {
        fundingMode: 'member_contributions',
        lowBalanceAlertCredits: 20,
        largeRunAlertPercent: 50,
      },
    });
  });

  it('records the new settings in the admin log', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateGroup.mockResolvedValue({
      fundingMode: 'member_contributions',
      lowBalanceAlertCredits: 20,
      largeRunAlertPercent: 50,
    });

    await updateGroupBudgetSettings('user_m', 'grp_1', { fundingMode: 'member_contributions' });

    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      action: 'budget_changed',
      metadata: {
        fundingMode: 'member_contributions',
        lowBalanceAlertCredits: 20,
        largeRunAlertPercent: 50,
      },
    });
  });
});

describe('setMemberDailyCreditCap', () => {
  it('refuses a non-admin', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('member'));

    const result = await setMemberDailyCreditCap('user_m', 'grp_1', 'user_b', 5);

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(updateMemberDailyCreditCap).not.toHaveBeenCalled();
  });

  it('is no_such_member when the repo finds nothing to update', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateMemberDailyCreditCap.mockResolvedValue(null);

    const result = await setMemberDailyCreditCap('user_m', 'grp_1', 'user_ghost', 5);

    expect(result).toEqual({ ok: false, reason: 'no_such_member' });
  });

  it('sets the cap on success, admin may cap themselves', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateMemberDailyCreditCap.mockResolvedValue({ userId: 'user_m', dailyCreditCap: 3 });

    const result = await setMemberDailyCreditCap('user_m', 'grp_1', 'user_m', 3);

    expect(updateMemberDailyCreditCap).toHaveBeenCalledWith('grp_1', 'user_m', 3);
    expect(result).toEqual({ ok: true, value: { userId: 'user_m', dailyCreditCap: 3 } });
  });

  it('records the cap change with the target as subject, not the actor', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateMemberDailyCreditCap.mockResolvedValue({ userId: 'user_b', dailyCreditCap: 7 });

    await setMemberDailyCreditCap('user_m', 'grp_1', 'user_b', 7);

    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      subjectUserId: 'user_b',
      action: 'member_cap_changed',
      metadata: { dailyCreditCap: 7 },
    });
  });

  it('writes no entry when there was no such member to cap', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    updateMemberDailyCreditCap.mockResolvedValue(null);

    await setMemberDailyCreditCap('user_m', 'grp_1', 'user_ghost', 5);

    expect(recordGroupAudit).not.toHaveBeenCalled();
  });
});

describe('topUpGroup', () => {
  it('refuses a viewer outright', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('viewer'));

    const result = await topUpGroup('user_m', 'grp_1', 10);

    expect(result).toEqual({ ok: false, reason: 'top_up_not_allowed' });
    expect(transferCreditsToGroup).not.toHaveBeenCalled();
  });

  it('refuses a member under self_funded', async () => {
    resolveGroupMembership.mockResolvedValue({
      membership: { group: { ...GROUP, fundingMode: 'self_funded' }, dailyCreditCap: null },
      scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role: 'member' }),
    });

    const result = await topUpGroup('user_m', 'grp_1', 10);

    expect(result).toEqual({ ok: false, reason: 'top_up_not_allowed' });
  });

  it('allows a member under member_contributions', async () => {
    resolveGroupMembership.mockResolvedValue({
      membership: {
        group: { ...GROUP, fundingMode: 'member_contributions' },
        dailyCreditCap: null,
      },
      scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role: 'member' }),
    });
    transferCreditsToGroup.mockResolvedValue({ groupBalanceCredits: 55 });

    const result = await topUpGroup('user_m', 'grp_1', 10);

    expect(result).toEqual({ ok: true, value: { balanceCredits: 55 } });
  });

  it('allows an admin under self_funded', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue({ groupBalanceCredits: 20 });

    const result = await topUpGroup('user_m', 'grp_1', 10);

    expect(result).toEqual({ ok: true, value: { balanceCredits: 20 } });
  });

  it('is insufficient_personal_credits when the transfer returns null, and writes nothing', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue(null);

    const result = await topUpGroup('user_m', 'grp_1', 999);

    expect(result).toEqual({ ok: false, reason: 'insufficient_personal_credits' });
  });

  it('makes sure the giver has a brain before touching their account', async () => {
    // Third review pass: a person who joined through a group invite may never
    // have opened their own brain, and a credit account cannot exist without it.
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue({ groupBalanceCredits: 20 });

    await topUpGroup('user_m', 'grp_1', 10);

    expect(ensureResparkableSpace).toHaveBeenCalledWith('user_m');
  });

  it('moves credits from the caller’s own space to the group’s, and no other pairing', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue({ groupBalanceCredits: 20 });

    await topUpGroup('user_m', 'grp_1', 10);

    const [from, to, credits] = transferCreditsToGroup.mock.calls[0] ?? [];
    expect(from).toMatchObject({ spaceId: 'user_m', actorUserId: 'user_m', role: 'owner' });
    expect(to).toMatchObject({ spaceId: 'spc_group' });
    expect(credits).toBe(10);
  });

  it('records the top-up with the credits moved', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue({ groupBalanceCredits: 20 });

    await topUpGroup('user_m', 'grp_1', 10);

    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      action: 'topped_up',
      metadata: { credits: 10 },
    });
  });

  it('writes no entry when the transfer was refused for insufficient credits', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    transferCreditsToGroup.mockResolvedValue(null);

    await topUpGroup('user_m', 'grp_1', 999);

    expect(recordGroupAudit).not.toHaveBeenCalled();
  });
});

describe('notifyGroupBudgetThresholds', () => {
  const groupScope = spaceScopeFor({ spaceId: 'spc_group', actorUserId: null, role: 'member' });

  beforeEach(() => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: 10,
      largeRunAlertPercent: 50,
    });
    listMemberContacts.mockResolvedValue([{ userId: 'user_a', email: 'admin@example.com' }]);
    sendEmail.mockResolvedValue({ success: true });
    claimLargeRunAlert.mockResolvedValue(true);
    releaseLargeRunAlert.mockResolvedValue(undefined);
  });

  it('does not send large_run once the balance was already at or below the low mark', async () => {
    // Reviewed 2026-09-25: at a low balance nearly every run is "large", and the
    // low-balance alert has already told the admins.
    const result = await notifyGroupBudgetThresholds(groupScope, { before: 8, after: 2 });

    expect(result.sent).toEqual([]);
    expect(claimLargeRunAlert).not.toHaveBeenCalled();
  });

  it('sends large_run at most once in 24 hours, by claiming it', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });
    const now = new Date('2026-09-25T10:00:00.000Z');
    claimLargeRunAlert.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 4 }, now);
    const second = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 4 }, now);

    expect(first.sent).toEqual(['large_run']);
    expect(second.sent).toEqual([]);
    expect(claimLargeRunAlert).toHaveBeenCalledWith('grp_1', now, 24 * 60 * 60_000);
  });

  it('does not use up the day’s large-run alert on a run that is not large', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });

    await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 9 });

    expect(claimLargeRunAlert).not.toHaveBeenCalled();
  });

  it('sends nothing for an owner scope', async () => {
    const ownerScope = spaceScopeFor({ spaceId: 'user_a', actorUserId: 'user_a', role: 'owner' });

    const result = await notifyGroupBudgetThresholds(ownerScope, { before: 5, after: 0 });

    expect(result).toEqual({ sent: [] });
    expect(findGroupBySpaceId).not.toHaveBeenCalled();
  });

  it('does not treat float noise just above the mark as a fresh crossing', async () => {
    // `before` is rebuilt as after minus the debit. A balance that sat exactly
    // on the mark can come back as 10.000000000000002.
    const result = await notifyGroupBudgetThresholds(groupScope, {
      before: 10.000000000000002,
      after: 9,
    });

    expect(result.sent).not.toContain('low_balance');
  });

  it('fires low_balance only on the crossing, not when already below the mark', async () => {
    const result = await notifyGroupBudgetThresholds(groupScope, { before: 12, after: 8 });

    expect(result.sent).toEqual(['low_balance']);

    sendEmail.mockClear();
    const already = await notifyGroupBudgetThresholds(groupScope, { before: 8, after: 4 });

    expect(already.sent).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('fires large_run when the cost exceeds the configured share of what was left', async () => {
    // before=10, percent=50 → threshold cost is 5; a cost of 6 exceeds it.
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 4 });

    expect(result.sent).toEqual(['large_run']);
  });

  it('does not fire large_run at exactly the configured share', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });

    // before=10, percent=50 → threshold cost is 5; a cost of exactly 5 does not exceed it.
    const result = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 5 });

    expect(result.sent).toEqual([]);
  });

  it('sends neither alert when both are off', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: null,
      largeRunAlertedAt: null,
    });

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 0 });

    expect(result.sent).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('emails only the group’s admins', async () => {
    await notifyGroupBudgetThresholds(groupScope, { before: 12, after: 8 });

    expect(listMemberContacts).toHaveBeenCalledWith('grp_1', { roles: ['admin'] });
  });

  it('swallows a sendEmail throw rather than rejecting', async () => {
    sendEmail.mockRejectedValue(new Error('smtp down'));

    await expect(
      notifyGroupBudgetThresholds(groupScope, { before: 12, after: 8 })
    ).resolves.toEqual({ sent: [] });
  });

  it('claims nothing and sends nothing when the group has no admins', async () => {
    listMemberContacts.mockResolvedValue([]);

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 12, after: 8 });

    expect(result.sent).toEqual([]);
    expect(claimLargeRunAlert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('releases the large-run claim, with the same claimedAt, when every send fails', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });
    listMemberContacts.mockResolvedValue([
      { userId: 'user_a', email: 'admin1@example.com' },
      { userId: 'user_b', email: 'admin2@example.com' },
    ]);
    sendEmail.mockResolvedValue({ success: false });
    const now = new Date('2026-09-25T12:00:00.000Z');

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 4 }, now);

    expect(result.sent).toEqual([]);
    expect(releaseLargeRunAlert).toHaveBeenCalledWith('grp_1', now);
  });

  it('treats a rejected sendEmail the same as a resolved failure, not a thrown error', async () => {
    findGroupBySpaceId.mockResolvedValue({
      id: 'grp_1',
      name: 'Study Group B',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: 50,
    });
    listMemberContacts.mockResolvedValue([{ userId: 'user_a', email: 'admin1@example.com' }]);
    sendEmail.mockRejectedValue(new Error('smtp down'));
    const now = new Date('2026-09-25T12:00:00.000Z');

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 10, after: 4 }, now);

    expect(result.sent).toEqual([]);
    expect(releaseLargeRunAlert).toHaveBeenCalledWith('grp_1', now);
  });

  it('reports low_balance sent when at least one of several admins receives it', async () => {
    listMemberContacts.mockResolvedValue([
      { userId: 'user_a', email: 'admin1@example.com' },
      { userId: 'user_b', email: 'admin2@example.com' },
    ]);
    sendEmail
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('smtp down'));

    const result = await notifyGroupBudgetThresholds(groupScope, { before: 12, after: 8 });

    expect(result.sent).toEqual(['low_balance']);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

// ─── Who pays (phase 62) ──────────────────────────────────────────────────────

/** A membership row for a group with some columns overridden. */
function rowFor(
  role: 'admin' | 'member' | 'viewer',
  group: Record<string, unknown> = {},
  membership: Record<string, unknown> = {}
) {
  const base = membershipRow(role);
  return {
    ...base,
    membership: { ...base.membership, group: { ...GROUP, ...group }, ...membership },
  };
}

const NOW = new Date('2026-10-20T12:00:00Z');
/** GROUP was created on the 5th, so its month turns over on the 5th, UTC. */
const MONTH_START = new Date('2026-10-05T00:00:00Z');
const NEXT_MONTH_START = '2026-11-05T00:00:00.000Z';

const POOL_SETTINGS = {
  seatPriceAdminCredits: 0,
  seatPriceMemberCredits: 0,
  seatPriceViewerCredits: 0,
  operationalCostsPaidBy: 'pool',
  operationalPayerUserId: null,
  activityCostsPaidBy: 'pool',
  allowanceSource: 'carved',
  shortfallPolicy: 'debt',
};

describe('getGroupBudget: who pays (phase 62)', () => {
  it('shows the settings in force, the month bounds, and no pending when nothing waits', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member'));

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing).toEqual({
      settings: POOL_SETTINGS,
      pending: null,
      monthStartedAt: MONTH_START.toISOString(),
      nextMonthStartsAt: NEXT_MONTH_START,
      timeZone: 'UTC',
      operationalPayerName: null,
    });
  });

  it('names the admin who pays running costs, and only when one admin pays', async () => {
    findAccountNames.mockResolvedValue(new Map([['user_p', 'Priya Patel']]));
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_p' })
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing.operationalPayerName).toBe('Priya Patel');
    expect(findAccountNames).toHaveBeenCalledWith(['user_p']);
  });

  it('gives no payer name when the pool pays, even if a stale payer id is stored', async () => {
    findAccountNames.mockResolvedValue(new Map([['user_p', 'Priya Patel']]));
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', { operationalCostsPaidBy: 'pool', operationalPayerUserId: 'user_p' })
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing.operationalPayerName).toBeNull();
  });

  it('reports the group clock as the billing time zone', async () => {
    findGroupWithClockBySpaceId.mockResolvedValue({ ...GROUP, timezone: 'Pacific/Auckland' });
    resolveGroupMembership.mockResolvedValue(rowFor('member'));

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing.timeZone).toBe('Pacific/Auckland');
  });

  it('shows a pending change only while its start is still in the future', async () => {
    const pending = { ...POOL_SETTINGS, seatPriceMemberCredits: 7 };
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', { pendingBilling: pending, pendingBillingFrom: new Date(NEXT_MONTH_START) })
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing.pending).toEqual({ settings: pending, from: NEXT_MONTH_START });
    // Not in force yet: the settings the caller is charged under are the stored ones.
    expect(result.value.billing.settings.seatPriceMemberCredits).toBe(0);
  });

  it('shows no pending once its start has passed, and the promoted settings are in force', async () => {
    const pending = { ...POOL_SETTINGS, seatPriceMemberCredits: 7 };
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', {
        pendingBilling: pending,
        pendingBillingFrom: new Date('2026-10-05T00:00:00Z'),
      })
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.billing.pending).toBeNull();
    expect(result.value.billing.settings.seatPriceMemberCredits).toBe(7);
  });

  it('reads the month on the group’s own clock', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member'));
    findGroupWithClockBySpaceId.mockResolvedValue({ ...GROUP, timezone: 'Pacific/Auckland' });

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    // Midnight on the 5th in Auckland (UTC+13 in October) is the 4th, 11:00 UTC.
    expect(result.value.billing.monthStartedAt).toBe('2026-10-04T11:00:00.000Z');
    expect(result.value.billing.nextMonthStartsAt).toBe('2026-11-04T11:00:00.000Z');
  });

  it('carries the caller’s own money figures, rounded', async () => {
    resolveGroupMembership.mockResolvedValue(
      rowFor(
        'member',
        {},
        {
          balanceCredits: 12.345,
          allowanceCredits: 30,
          allowanceRemainingCredits: 8.126,
          autoTopUpMonthlyCredits: 50,
        }
      )
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.you).toMatchObject({
      balanceCredits: 12.35,
      allowanceCredits: 30,
      allowanceRemainingCredits: 8.13,
      autoTopUpMonthlyCredits: 50,
    });
  });

  it.each([
    ['suspend', -0.5, true],
    ['suspend', 0, false],
    ['suspend', 4, false],
    ['debt', -50, false],
  ])('with policy %s and balance %d, suspended is %s', async (policy, balance, suspended) => {
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', { shortfallPolicy: policy }, { balanceCredits: balance })
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.you.suspended).toBe(suspended);
  });

  it('counts the automatic top-up used only when it was used in this group month', async () => {
    resolveGroupMembership.mockResolvedValue(
      rowFor('member', {}, { autoTopUpMonth: MONTH_START, autoTopUpUsedCredits: 12.345 })
    );

    const thisMonth = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!thisMonth.ok) throw new Error('unreachable');
    expect(thisMonth.value.you.autoTopUpUsedThisMonthCredits).toBe(12.35);
  });

  it('reads the automatic top-up used as 0 when it was last used in another month', async () => {
    resolveGroupMembership.mockResolvedValue(
      rowFor(
        'member',
        {},
        { autoTopUpMonth: new Date('2026-09-05T00:00:00Z'), autoTopUpUsedCredits: 40 }
      )
    );

    const result = await getGroupBudget('user_m', 'grp_1', NOW);

    if (!result.ok) throw new Error('unreachable');
    expect(result.value.you.autoTopUpUsedThisMonthCredits).toBe(0);
  });
});

describe('updateGroupBilling', () => {
  const GROUP_AFTER_SET = { ...GROUP };

  beforeEach(() => {
    setPendingBilling.mockResolvedValue(GROUP_AFTER_SET);
    findGroupBySpaceId.mockResolvedValue(GROUP);
    findJoinedMembership.mockResolvedValue(null);
  });

  it('is not_a_member for a caller with no membership, and writes nothing', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    const result = await updateGroupBilling(
      'user_x',
      'grp_1',
      { seatPriceMemberCredits: 4 },
      {},
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(setPendingBilling).not.toHaveBeenCalled();
  });

  it.each(['member', 'viewer'] as const)('refuses a %s without writing', async (role) => {
    resolveGroupMembership.mockResolvedValue(rowFor(role));

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { seatPriceMemberCredits: 4 },
      {},
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(setPendingBilling).not.toHaveBeenCalled();
    expect(promotePendingBilling).not.toHaveBeenCalled();
    expect(recordGroupAudit).not.toHaveBeenCalled();
  });

  it('schedules the change for the group’s next month start, never at once', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { seatPriceMemberCredits: 4 },
      {},
      NOW
    );

    const expected = { ...POOL_SETTINGS, seatPriceMemberCredits: 4 };
    expect(setPendingBilling).toHaveBeenCalledWith('grp_1', expected, new Date(NEXT_MONTH_START));
    expect(result).toEqual({
      ok: true,
      value: {
        settings: POOL_SETTINGS,
        pending: { settings: expected, from: NEXT_MONTH_START },
      },
    });
  });

  it('computes the start on the group’s clock', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    findGroupWithClockBySpaceId.mockResolvedValue({ ...GROUP, timezone: 'Pacific/Auckland' });

    await updateGroupBilling('user_m', 'grp_1', { shortfallPolicy: 'suspend' }, {}, NOW);

    expect(setPendingBilling.mock.calls[0]?.[2]).toEqual(new Date('2026-11-04T11:00:00Z'));
  });

  it('records billing_changed with the fields changed and when they start', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));

    await updateGroupBilling('user_m', 'grp_1', { allowanceSource: 'filled' }, {}, NOW);

    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      action: 'billing_changed',
      metadata: { allowanceSource: 'filled', from: NEXT_MONTH_START },
    });
  });

  it('merges over a change already waiting, so a second change does not undo the first', async () => {
    const waiting = { ...POOL_SETTINGS, activityCostsPaidBy: 'equal_split' };
    const group = {
      ...GROUP,
      pendingBilling: waiting,
      pendingBillingFrom: new Date(NEXT_MONTH_START),
    };
    resolveGroupMembership.mockResolvedValue(rowFor('admin', group));

    await updateGroupBilling('user_m', 'grp_1', { seatPriceViewerCredits: 2 }, {}, NOW);

    expect(setPendingBilling).toHaveBeenCalledWith(
      'grp_1',
      { ...waiting, seatPriceViewerCredits: 2 },
      new Date(NEXT_MONTH_START)
    );
    expect(promotePendingBilling).not.toHaveBeenCalled();
  });

  it('promotes a pending change whose start has passed before writing the new one', async () => {
    const due = { ...POOL_SETTINGS, seatPriceAdminCredits: 9 };
    const dueFrom = new Date('2026-10-05T00:00:00Z');
    resolveGroupMembership.mockResolvedValue(
      rowFor('admin', { pendingBilling: due, pendingBillingFrom: dueFrom })
    );
    // After promotion the columns carry the due settings and pending is clear.
    findGroupBySpaceId.mockResolvedValue({ ...GROUP, ...due });

    await updateGroupBilling('user_m', 'grp_1', { seatPriceMemberCredits: 4 }, {}, NOW);

    expect(promotePendingBilling).toHaveBeenCalledWith('grp_1', dueFrom, due, NOW);
    // Promoted first, so the new change builds on it rather than losing it.
    expect(promotePendingBilling.mock.invocationCallOrder[0]).toBeLessThan(
      setPendingBilling.mock.invocationCallOrder[0] ?? 0
    );
    expect(setPendingBilling).toHaveBeenCalledWith(
      'grp_1',
      { ...due, seatPriceMemberCredits: 4 },
      new Date(NEXT_MONTH_START)
    );
  });

  it('refuses one_admin with a payer who is not a joined admin, writing nothing', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    findJoinedMembership.mockResolvedValue({ role: 'member' });

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_b' },
      {},
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'payer_not_admin' });
    expect(findJoinedMembership).toHaveBeenCalledWith('grp_1', 'user_b');
    expect(setPendingBilling).not.toHaveBeenCalled();
    expect(recordGroupAudit).not.toHaveBeenCalled();
  });

  it('refuses one_admin whose payer is not a member at all', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    findJoinedMembership.mockResolvedValue(null);

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_ghost' },
      {},
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'payer_not_admin' });
    expect(setPendingBilling).not.toHaveBeenCalled();
  });

  it('refuses one_admin with no payer named, without looking one up', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { operationalCostsPaidBy: 'one_admin' },
      {},
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'payer_not_admin' });
    expect(findJoinedMembership).not.toHaveBeenCalled();
    expect(setPendingBilling).not.toHaveBeenCalled();
  });

  it('accepts one_admin with a joined admin as payer', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    findJoinedMembership.mockResolvedValue({ role: 'admin' });

    const result = await updateGroupBilling(
      'user_m',
      'grp_1',
      { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_adm' },
      {},
      NOW
    );

    expect(result.ok).toBe(true);
    expect(setPendingBilling).toHaveBeenCalledWith(
      'grp_1',
      { ...POOL_SETTINGS, operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_adm' },
      new Date(NEXT_MONTH_START)
    );
  });

  it('clears the payer id when the change is to anything but one_admin', async () => {
    resolveGroupMembership.mockResolvedValue(
      rowFor('admin', { operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'user_adm' })
    );

    await updateGroupBilling(
      'user_m',
      'grp_1',
      { operationalCostsPaidBy: 'admins_split' },
      {},
      NOW
    );

    expect(setPendingBilling).toHaveBeenCalledWith(
      'grp_1',
      { ...POOL_SETTINGS, operationalCostsPaidBy: 'admins_split', operationalPayerUserId: null },
      new Date(NEXT_MONTH_START)
    );
    expect(findJoinedMembership).not.toHaveBeenCalled();
  });

  it('discardPending drops a change still waiting, audits it, and writes no new one', async () => {
    const group = {
      ...GROUP,
      pendingBilling: { ...POOL_SETTINGS, seatPriceMemberCredits: 7 },
      pendingBillingFrom: new Date(NEXT_MONTH_START),
    };
    resolveGroupMembership.mockResolvedValue(rowFor('admin', group));
    clearPendingBilling.mockResolvedValue(GROUP);

    const result = await updateGroupBilling('user_m', 'grp_1', {}, { discardPending: true }, NOW);

    expect(clearPendingBilling).toHaveBeenCalledWith('grp_1');
    expect(setPendingBilling).not.toHaveBeenCalled();
    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      action: 'billing_changed',
      metadata: { discarded: true },
    });
    expect(result).toEqual({ ok: true, value: { settings: POOL_SETTINGS, pending: null } });
  });

  it('discardPending with nothing waiting is a quiet success: no write, no audit', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));

    const result = await updateGroupBilling('user_m', 'grp_1', {}, { discardPending: true }, NOW);

    expect(result).toEqual({ ok: true, value: { settings: POOL_SETTINGS, pending: null } });
    expect(clearPendingBilling).not.toHaveBeenCalled();
    expect(recordGroupAudit).not.toHaveBeenCalled();
  });
});

describe('setMemberAllowance', () => {
  it('is not_a_member for an unresolvable caller', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    expect(await setMemberAllowance('user_x', 'grp_1', 'user_b', 10)).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
    expect(updateMemberAllowance).not.toHaveBeenCalled();
  });

  it('refuses a non-admin without writing', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member'));

    const result = await setMemberAllowance('user_m', 'grp_1', 'user_b', 10);

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(updateMemberAllowance).not.toHaveBeenCalled();
  });

  it('is no_such_member, with no audit entry, when the repo matched no joined row', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    updateMemberAllowance.mockResolvedValue(false);

    const result = await setMemberAllowance('user_m', 'grp_1', 'user_ghost', 10);

    expect(result).toEqual({ ok: false, reason: 'no_such_member' });
    expect(recordGroupAudit).not.toHaveBeenCalled();
  });

  it('sets the allowance for the target and audits it with the target as subject', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    updateMemberAllowance.mockResolvedValue(true);

    const result = await setMemberAllowance('user_m', 'grp_1', 'user_b', 25);

    expect(updateMemberAllowance).toHaveBeenCalledWith('grp_1', 'user_b', 25);
    expect(result).toEqual({ ok: true, value: { userId: 'user_b', allowanceCredits: 25 } });
    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: 'user_m',
      subjectUserId: 'user_b',
      action: 'member_allowance_changed',
      metadata: { allowanceCredits: 25 },
    });
  });

  it('clears an allowance with null', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    updateMemberAllowance.mockResolvedValue(true);

    const result = await setMemberAllowance('user_m', 'grp_1', 'user_b', null);

    expect(updateMemberAllowance).toHaveBeenCalledWith('grp_1', 'user_b', null);
    expect(result).toEqual({ ok: true, value: { userId: 'user_b', allowanceCredits: null } });
  });
});

describe('setOwnAutoTopUp', () => {
  it('is not_a_member for an unresolvable caller', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    expect(await setOwnAutoTopUp('user_x', 'grp_1', 10)).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
    expect(updateMemberAutoTopUp).not.toHaveBeenCalled();
  });

  it('writes only the caller’s own row, whatever their role, and does not audit', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('viewer'));
    updateMemberAutoTopUp.mockResolvedValue(true);

    const result = await setOwnAutoTopUp('user_m', 'grp_1', 40);

    expect(updateMemberAutoTopUp).toHaveBeenCalledWith('grp_1', 'user_m', 40);
    expect(result).toEqual({ ok: true, value: { autoTopUpMonthlyCredits: 40 } });
    expect(recordGroupAudit).not.toHaveBeenCalled();
  });

  it('withdraws with null', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('admin'));
    updateMemberAutoTopUp.mockResolvedValue(true);

    const result = await setOwnAutoTopUp('user_m', 'grp_1', null);

    expect(updateMemberAutoTopUp).toHaveBeenCalledWith('grp_1', 'user_m', null);
    expect(result).toEqual({ ok: true, value: { autoTopUpMonthlyCredits: null } });
  });

  it('is not_a_member when the repo matched no joined row', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member'));
    updateMemberAutoTopUp.mockResolvedValue(false);

    expect(await setOwnAutoTopUp('user_m', 'grp_1', 40)).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
  });
});

describe('topUpOwnGroupBalance', () => {
  it('is not_a_member for an unresolvable caller, and touches no account', async () => {
    resolveGroupMembership.mockResolvedValue(null);

    expect(await topUpOwnGroupBalance('user_x', 'grp_1', 10)).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
    expect(ensureResparkableSpace).not.toHaveBeenCalled();
    expect(transferCreditsToMemberBalance).not.toHaveBeenCalled();
  });

  it('moves credits from the caller’s own space into their own balance in this group', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('viewer'));
    transferCreditsToMemberBalance.mockResolvedValue({ memberBalanceCredits: 35.456 });

    const result = await topUpOwnGroupBalance('user_m', 'grp_1', 10);

    expect(ensureResparkableSpace).toHaveBeenCalledWith('user_m');
    const [from, to, groupId, credits, note] = transferCreditsToMemberBalance.mock.calls[0] ?? [];
    expect(from).toMatchObject({ spaceId: 'user_m', actorUserId: 'user_m', role: 'owner' });
    expect(to).toMatchObject({ spaceId: 'spc_group' });
    expect(groupId).toBe('grp_1');
    expect(credits).toBe(10);
    expect(note).toBe('Top-up to my balance in Study Group B');
    // Rounded for display.
    expect(result).toEqual({ ok: true, value: { memberBalanceCredits: 35.46 } });
  });

  it('is insufficient_personal_credits when the transfer is refused', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member'));
    transferCreditsToMemberBalance.mockResolvedValue(null);

    expect(await topUpOwnGroupBalance('user_m', 'grp_1', 999)).toEqual({
      ok: false,
      reason: 'insufficient_personal_credits',
    });
  });

  it('keeps the ledger note within 500 characters for a very long group name', async () => {
    resolveGroupMembership.mockResolvedValue(rowFor('member', { name: 'G'.repeat(900) }));
    transferCreditsToMemberBalance.mockResolvedValue({ memberBalanceCredits: 1 });

    await topUpOwnGroupBalance('user_m', 'grp_1', 1);

    const note = transferCreditsToMemberBalance.mock.calls[0]?.[4];
    expect(typeof note).toBe('string');
    expect((note as string).length).toBe(500);
  });
});

/** What the recipient reads: the email rendered to plain text. */
async function renderText(element: ReactElement): Promise<string> {
  return render(element, { plainText: true });
}

describe('releasePayerAndTell', () => {
  const admins = [
    { userId: 'user_a', email: 'a@example.com' },
    { userId: 'user_b', email: 'b@example.com' },
  ];

  beforeEach(() => {
    releaseOperationalPayer.mockResolvedValue(true);
    findGroupById.mockResolvedValue(GROUP);
    listMemberContacts.mockResolvedValue(admins);
    findCreditAccount.mockResolvedValue({ balanceCredits: 40 });
    sendEmail.mockResolvedValue({ success: true });
  });

  it('is a no-op returning false when nothing was released: no audit, no email', async () => {
    releaseOperationalPayer.mockResolvedValue(false);

    const released = await releasePayerAndTell('grp_1', 'user_z');

    expect(released).toBe(false);
    expect(releaseOperationalPayer).toHaveBeenCalledWith('grp_1', 'user_z');
    expect(recordGroupAudit).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('audits payer_released with no actor and the payer as subject', async () => {
    await releasePayerAndTell('grp_1', 'user_adm');

    expect(recordGroupAudit).toHaveBeenCalledWith({
      groupId: 'grp_1',
      actorUserId: null,
      subjectUserId: 'user_adm',
      action: 'payer_released',
    });
  });

  it('emails each admin the payer_gone notice with the pool balance', async () => {
    const released = await releasePayerAndTell('grp_1', 'user_adm');

    expect(released).toBe(true);
    expect(listMemberContacts).toHaveBeenCalledWith('grp_1', { roles: ['admin'] });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map((call) => call[0].to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    const first = sendEmail.mock.calls[0]?.[0];
    expect(first.subject).toBe("Study Group B's shared balance now pays its running costs");
    const text = await renderText(first.react);
    expect(text).toContain('Study Group B');
    expect(text).toContain('It has 40 credits.');
    expect(text).toContain('https://app.example.com/');
  });

  it('shows a pool in debt as 0 in the email, never a negative balance', async () => {
    findCreditAccount.mockResolvedValue({ balanceCredits: -12 });

    await releasePayerAndTell('grp_1', 'user_adm');

    const text = await renderText(sendEmail.mock.calls[0]?.[0].react);
    expect(text).toContain('It has 0 credits.');
    expect(text).not.toContain('-12');
  });

  it('sends no email, but still reports the release, when the group has gone', async () => {
    findGroupById.mockResolvedValue(null);

    const released = await releasePayerAndTell('grp_1', 'user_adm');

    expect(released).toBe(true);
    expect(recordGroupAudit).toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('keeps telling the other admins when one send fails', async () => {
    sendEmail
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValueOnce({ success: true });

    const released = await releasePayerAndTell('grp_1', 'user_adm');

    expect(released).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('never throws: a failing release resolves false', async () => {
    releaseOperationalPayer.mockRejectedValue(new Error('db down'));

    await expect(releasePayerAndTell('grp_1', 'user_adm')).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws: a failing audit write resolves false', async () => {
    recordGroupAudit.mockRejectedValueOnce(new Error('audit down'));

    await expect(releasePayerAndTell('grp_1', 'user_adm')).resolves.toBe(false);
  });
});
