/**
 * Unit Tests: the group budget service (§23.12, phase 50).
 *
 * Four properties matter most:
 *
 * **Only an admin sees per-person spend.** A member's `admin` is `null`, and
 * the two admin-only reads (`summariseLedgerByMemberSince`, `listGroupMembers`)
 * are never called on their path, not merely that the result hides the field.
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findCreditAccount = vi.fn();
const summariseLedgerByMemberSince = vi.fn();
const sumMemberSpendSince = vi.fn();
const transferCreditsToGroup = vi.fn();
const ensureCreditAccount = vi.fn();

const findGroupBySpaceId = vi.fn();
const listGroupMembers = vi.fn();
const listMemberContacts = vi.fn();
const updateGroup = vi.fn();
const updateMemberDailyCreditCap = vi.fn();
const claimLargeRunAlert = vi.fn();
const releaseLargeRunAlert = vi.fn();

const sendEmail = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
  summariseLedgerByMemberSince: (...args: unknown[]) => summariseLedgerByMemberSince(...args),
  sumMemberSpendSince: (...args: unknown[]) => sumMemberSpendSince(...args),
  transferCreditsToGroup: (...args: unknown[]) => transferCreditsToGroup(...args),
  ensureCreditAccount: (...args: unknown[]) => ensureCreditAccount(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findGroupBySpaceId: (...args: unknown[]) => findGroupBySpaceId(...args),
  listGroupMembers: (...args: unknown[]) => listGroupMembers(...args),
  listMemberContacts: (...args: unknown[]) => listMemberContacts(...args),
  updateGroup: (...args: unknown[]) => updateGroup(...args),
  updateMemberDailyCreditCap: (...args: unknown[]) => updateMemberDailyCreditCap(...args),
  claimLargeRunAlert: (...args: unknown[]) => claimLargeRunAlert(...args),
  releaseLargeRunAlert: (...args: unknown[]) => releaseLargeRunAlert(...args),
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
const ensureResparkableSpace = vi.fn().mockResolvedValue({});
vi.mock('@/lib/framework/resparkable/services/space', () => ({
  ensureResparkableSpace: (...args: unknown[]) => ensureResparkableSpace(...args),
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
  setMemberDailyCreditCap,
  topUpGroup,
  updateGroupBudgetSettings,
} from '@/lib/framework/resparkable/services/group-budget';

const GROUP = {
  id: 'grp_1',
  name: 'Study Group B',
  fundingMode: 'self_funded',
  lowBalanceAlertCredits: null as number | null,
  largeRunAlertPercent: null as number | null,
};

function membershipRow(role: 'admin' | 'member' | 'viewer', dailyCreditCap: number | null = null) {
  return {
    membership: { group: GROUP, dailyCreditCap },
    scope: spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findCreditAccount.mockResolvedValue(null);
  sumMemberSpendSince.mockResolvedValue(0);
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
    expect(summariseLedgerByMemberSince).not.toHaveBeenCalled();
    expect(listGroupMembers).not.toHaveBeenCalled();
  });

  it('gives an admin per-member rows merged from the ledger summary', async () => {
    resolveGroupMembership.mockResolvedValue(membershipRow('admin'));
    findCreditAccount.mockResolvedValue({ balanceCredits: 100 });
    listGroupMembers.mockResolvedValue([
      { userId: 'user_a', role: 'admin', dailyCreditCap: null, joinedAt: new Date('2026-01-01') },
      { userId: 'user_b', role: 'member', dailyCreditCap: 5, joinedAt: new Date('2026-01-02') },
    ]);
    summariseLedgerByMemberSince.mockResolvedValue([
      { userId: 'user_a', spentCredits: 12.345, contributedCredits: 0 },
      // user_b has no ledger rows in the window at all.
    ]);

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.admin?.members).toEqual([
      {
        userId: 'user_a',
        role: 'admin',
        dailyCreditCap: null,
        spentCredits: 12.35,
        contributedCredits: 0,
      },
      {
        userId: 'user_b',
        role: 'member',
        dailyCreditCap: 5,
        spentCredits: 0,
        contributedCredits: 0,
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
    summariseLedgerByMemberSince.mockResolvedValue([]);

    const result = await getGroupBudget('user_m', 'grp_1');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.admin?.members.map((m) => m.userId)).toEqual(['user_a']);
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
    expect(result.value.you).toEqual({ dailyCreditCap: 7, spentLastDayCredits: 2.46 });
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
