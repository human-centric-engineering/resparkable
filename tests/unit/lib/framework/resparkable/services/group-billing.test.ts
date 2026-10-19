/**
 * Unit Tests: the group billing service (Phase 62), who pays in a group.
 *
 * The properties that matter: settings in force at a moment (pending changes
 * apply lazily once their date passes), the group's month (anchor day folded to
 * the 28th, on the group's clock), and `resolveCharge` returning the one source
 * a run is charged to, or refusing before any provider call.
 *
 * @see lib/framework/resparkable/services/group-billing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyAutoTopUp = vi.fn();
const findGroupWithClockBySpaceId = vi.fn();
const findJoinedMembership = vi.fn();
const listJoinedMembersByRole = vi.fn();
const poolAvailableCredits = vi.fn();
const sumMemberOwnSpendSince = vi.fn();
const ensureCreditAccount = vi.fn();
const findCreditAccount = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/group-billing', () => ({
  applyAutoTopUp: (...args: unknown[]) => applyAutoTopUp(...args),
  findGroupWithClockBySpaceId: (...args: unknown[]) => findGroupWithClockBySpaceId(...args),
  findJoinedMembership: (...args: unknown[]) => findJoinedMembership(...args),
  listJoinedMembersByRole: (...args: unknown[]) => listJoinedMembersByRole(...args),
  poolAvailableCredits: (...args: unknown[]) => poolAvailableCredits(...args),
  sumMemberOwnSpendSince: (...args: unknown[]) => sumMemberOwnSpendSince(...args),
}));
const settleGroupMonths = vi.fn();
vi.mock('@/lib/framework/resparkable/repo/group-billing-cycle', () => ({
  settleGroupMonths: (...args: unknown[]) => settleGroupMonths(...args),
}));
vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  ensureCreditAccount: (...args: unknown[]) => ensureCreditAccount(...args),
  findCreditAccount: (...args: unknown[]) => findCreditAccount(...args),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ResparkableGroupMember } from '@prisma/client';

import { ForbiddenError, InsufficientCreditsError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import { spaceScope, spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import type { GroupWithClock } from '@/lib/framework/resparkable/repo/group-billing';
import {
  DEFAULT_GROUP_BILLING,
  GroupAllowanceUsedError,
  GroupMonthlyLimitError,
  GroupSuspendedError,
  canAffordOperational,
  cycleDue,
  effectiveBillingSettings,
  monthStartFor,
  nextMonthStartFor,
  planForRun,
  resolveCharge,
  seatPriceFor,
  settleGroupCycle,
  settleGroupCycleForSpace,
  storedBillingSettings,
  topUpAutomatically,
} from '@/lib/framework/resparkable/services/group-billing';

const NOW = new Date('2026-10-19T12:00:00Z');

function makeGroup(overrides: Partial<GroupWithClock> = {}): GroupWithClock {
  return {
    id: 'g1',
    spaceId: 'spc_group',
    createdAt: new Date('2026-01-10T12:00:00Z'),
    timezone: 'UTC',
    seatPriceAdminCredits: 0,
    seatPriceMemberCredits: 0,
    seatPriceViewerCredits: 0,
    operationalCostsPaidBy: 'pool',
    operationalPayerUserId: null,
    activityCostsPaidBy: 'pool',
    allowanceSource: 'carved',
    shortfallPolicy: 'debt',
    pendingBilling: null,
    pendingBillingFrom: null,
    ...overrides,
  } as GroupWithClock;
}

function makeMember(overrides: Partial<ResparkableGroupMember> = {}): ResparkableGroupMember {
  return {
    groupId: 'g1',
    userId: 'u1',
    role: 'member',
    balanceCredits: 10,
    allowanceCredits: null,
    allowanceRemainingCredits: 0,
    autoTopUpMonthlyCredits: null,
    autoTopUpUsedCredits: 0,
    autoTopUpMonth: null,
    joinedAt: new Date('2026-01-11T00:00:00Z'),
    ...overrides,
  } as ResparkableGroupMember;
}

const memberScope = spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'u1', role: 'member' });

function setup(
  group: GroupWithClock | null,
  membership: ResparkableGroupMember | null,
  pool = 100
) {
  findGroupWithClockBySpaceId.mockResolvedValue(group);
  findJoinedMembership.mockResolvedValue(membership);
  poolAvailableCredits.mockResolvedValue(pool);
}

beforeEach(() => {
  vi.resetAllMocks();
  settleGroupMonths.mockResolvedValue({ settled: false, seatsCharged: 0, shortUserIds: [] });
});

describe('storedBillingSettings', () => {
  it('falls back to the pool-paying defaults for unknown strings', () => {
    const settings = storedBillingSettings(
      makeGroup({
        operationalCostsPaidBy: 'nonsense',
        activityCostsPaidBy: 'whoever',
        allowanceSource: 'x',
        shortfallPolicy: 'y',
      })
    );

    expect(settings).toEqual(DEFAULT_GROUP_BILLING);
  });

  it('keeps recognised values and clamps negative seat prices to zero', () => {
    const settings = storedBillingSettings(
      makeGroup({
        activityCostsPaidBy: 'equal_split',
        shortfallPolicy: 'suspend',
        seatPriceAdminCredits: -5,
        seatPriceMemberCredits: 3,
      })
    );

    expect(settings).toMatchObject({
      activityCostsPaidBy: 'equal_split',
      shortfallPolicy: 'suspend',
      seatPriceAdminCredits: 0,
      seatPriceMemberCredits: 3,
    });
  });
});

describe('effectiveBillingSettings', () => {
  const pending = {
    ...DEFAULT_GROUP_BILLING,
    activityCostsPaidBy: 'equal_split',
    seatPriceMemberCredits: 7,
  };

  it('uses the stored columns while the pending date is in the future', () => {
    const group = makeGroup({
      pendingBilling: pending,
      pendingBillingFrom: new Date('2026-11-01T00:00:00Z'),
    });

    expect(effectiveBillingSettings(group, NOW).activityCostsPaidBy).toBe('pool');
  });

  it('applies the pending settings once pendingBillingFrom has passed', () => {
    const group = makeGroup({
      pendingBilling: pending,
      pendingBillingFrom: new Date('2026-10-01T00:00:00Z'),
    });

    expect(effectiveBillingSettings(group, NOW)).toEqual(pending);
  });

  it('applies the pending settings exactly at pendingBillingFrom', () => {
    const group = makeGroup({ pendingBilling: pending, pendingBillingFrom: NOW });

    expect(effectiveBillingSettings(group, NOW).seatPriceMemberCredits).toBe(7);
  });

  it('falls back to stored (and warns) when the pending value is unparseable', () => {
    const group = makeGroup({
      shortfallPolicy: 'suspend',
      pendingBilling: { activityCostsPaidBy: 'bogus' },
      pendingBillingFrom: new Date('2026-10-01T00:00:00Z'),
    });

    const result = effectiveBillingSettings(group, NOW);

    expect(result.shortfallPolicy).toBe('suspend');
    expect(result.activityCostsPaidBy).toBe('pool');
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { groupId: 'g1' });
  });

  it('uses stored when a date has passed but there is no pending value', () => {
    const group = makeGroup({
      pendingBilling: null,
      pendingBillingFrom: new Date('2026-10-01T00:00:00Z'),
    });

    expect(effectiveBillingSettings(group, NOW)).toEqual(DEFAULT_GROUP_BILLING);
  });
});

describe('seatPriceFor', () => {
  const settings = {
    ...DEFAULT_GROUP_BILLING,
    seatPriceAdminCredits: 1,
    seatPriceMemberCredits: 2,
    seatPriceViewerCredits: 3,
  };

  it.each([
    ['admin', 1],
    ['member', 2],
    ['viewer', 3],
    ['something_else', 2],
  ])('prices %s at %d', (role, price) => {
    expect(seatPriceFor(settings, role)).toBe(price);
  });
});

describe('monthStartFor / nextMonthStartFor', () => {
  it('starts on the creation day at midnight when that day has passed this month', () => {
    const group = makeGroup({ createdAt: new Date('2026-01-10T12:00:00Z') });

    expect(monthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-10-10T00:00:00Z'));
    expect(nextMonthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-11-10T00:00:00Z'));
  });

  it("steps back a month when this month's anchor is still ahead", () => {
    const group = makeGroup({ createdAt: new Date('2026-01-25T12:00:00Z') });

    expect(monthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-09-25T00:00:00Z'));
    expect(nextMonthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-10-25T00:00:00Z'));
  });

  it('folds a 31st anchor to the 28th', () => {
    const group = makeGroup({ createdAt: new Date('2026-01-31T12:00:00Z') });

    expect(monthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-09-28T00:00:00Z'));
    // February has no 31st; the folded anchor still exists.
    expect(monthStartFor(group, 'UTC', new Date('2027-02-28T00:00:00Z'))).toEqual(
      new Date('2027-02-28T00:00:00Z')
    );
  });

  it("is midnight in the group's zone, and the anchor day is read in that zone", () => {
    // 02:00Z on the 5th is still the 4th (21:00) in New York.
    const group = makeGroup({ createdAt: new Date('2026-03-05T02:00:00Z') });

    // Oct 4 00:00 EDT (UTC-4).
    expect(monthStartFor(group, 'America/New_York', NOW)).toEqual(new Date('2026-10-04T04:00:00Z'));
    expect(monthStartFor(group, 'UTC', NOW)).toEqual(new Date('2026-10-05T00:00:00Z'));
  });

  it("uses the zone's offset on the day, across a DST change", () => {
    const group = makeGroup({ createdAt: new Date('2026-01-31T12:00:00Z') });

    // Dec 28 00:00 EST (UTC-5), after DST ended.
    expect(monthStartFor(group, 'America/New_York', new Date('2026-12-30T12:00:00Z'))).toEqual(
      new Date('2026-12-28T05:00:00Z')
    );
  });
});

describe('resolveCharge: owner and viewer', () => {
  it('refuses a viewer', async () => {
    const viewer = spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'v1', role: 'viewer' });

    await expect(resolveCharge(viewer, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(findGroupWithClockBySpaceId).not.toHaveBeenCalled();
  });

  it('charges a personal owner with a positive balance to the space', async () => {
    ensureCreditAccount.mockResolvedValue({ balanceCredits: 5 });

    expect(await resolveCharge(spaceScope('u1'), NOW)).toEqual({ source: 'space' });
    expect(findGroupWithClockBySpaceId).not.toHaveBeenCalled();
  });

  it('refuses a personal owner at zero', async () => {
    ensureCreditAccount.mockResolvedValue({ balanceCredits: 0 });

    await expect(resolveCharge(spaceScope('u1'), NOW)).rejects.toBeInstanceOf(
      InsufficientCreditsError
    );
  });
});

describe('resolveCharge: group, pool pays', () => {
  it('returns the space plan when the pool net of debts is positive, never reading a personal account', async () => {
    setup(makeGroup(), makeMember(), 0.5);

    expect(await resolveCharge(memberScope, NOW)).toEqual({ source: 'space' });
    expect(findCreditAccount).not.toHaveBeenCalled();
    expect(ensureCreditAccount).not.toHaveBeenCalled();
  });

  it.each([0, -3])('refuses when the pool net of debts is %d', async (pool) => {
    setup(makeGroup(), makeMember(), pool);

    await expect(resolveCharge(memberScope, NOW)).rejects.toThrow(/credit balance is empty/);
    expect(findCreditAccount).not.toHaveBeenCalled();
  });

  it('refuses someone who is not a joined member', async () => {
    setup(makeGroup(), null);

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("with no group row, falls back to the scope's own account", async () => {
    setup(null, null);
    findCreditAccount.mockResolvedValue({ balanceCredits: 4 });

    expect(await resolveCharge(memberScope, NOW)).toEqual({ source: 'space' });
    expect(findCreditAccount).toHaveBeenCalledWith(memberScope);
  });

  it('with no actor, refuses on an empty own account', async () => {
    const background = spaceScopeFor({ spaceId: 'spc_group', actorUserId: null, role: 'member' });
    setup(makeGroup(), null);
    findCreditAccount.mockResolvedValue(null);

    await expect(resolveCharge(background, NOW)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('refuses a suspended member even when the pool pays', async () => {
    setup(makeGroup({ shortfallPolicy: 'suspend' }), makeMember({ balanceCredits: -2.345 }));

    const error = await resolveCharge(memberScope, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GroupSuspendedError);
    expect((error as GroupSuspendedError).message).toContain('2.35 credits');
    expect((error as GroupSuspendedError).code).toBe('GROUP_ACCESS_SUSPENDED');
  });

  it('lets a suspended member through when their automatic top-up clears the debt', async () => {
    setup(
      makeGroup({ shortfallPolicy: 'suspend' }),
      makeMember({ balanceCredits: -2, autoTopUpMonthlyCredits: 10 })
    );
    applyAutoTopUp.mockResolvedValue({ moved: 5, balanceAfter: 3, allowanceRemainingAfter: 0 });

    expect(await resolveCharge(memberScope, NOW)).toEqual({ source: 'space' });
    expect(applyAutoTopUp).toHaveBeenCalledWith(expect.objectContaining({ target: 'member' }));
  });

  it('does not suspend a negative balance under the debt policy', async () => {
    setup(makeGroup({ shortfallPolicy: 'debt' }), makeMember({ balanceCredits: -2 }));

    expect(await resolveCharge(memberScope, NOW)).toEqual({ source: 'space' });
  });
});

describe('resolveCharge: carved allowance', () => {
  const carved = () => makeGroup({ activityCostsPaidBy: 'allowance', allowanceSource: 'carved' });

  it('returns an allowance plan when allowance remains and the pool has credit', async () => {
    setup(carved(), makeMember({ allowanceRemainingCredits: 5 }));

    expect(await resolveCharge(memberScope, NOW)).toEqual({
      source: 'allowance',
      groupId: 'g1',
      memberUserId: 'u1',
    });
    expect(applyAutoTopUp).not.toHaveBeenCalled();
  });

  it('throws GroupAllowanceUsedError once used, after trying an auto top-up into the pool first', async () => {
    setup(carved(), makeMember({ allowanceRemainingCredits: 0, autoTopUpMonthlyCredits: 10 }));
    applyAutoTopUp.mockResolvedValue({ moved: 0, balanceAfter: 10, allowanceRemainingAfter: 0 });

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(GroupAllowanceUsedError);
    expect(applyAutoTopUp).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'pool_allowance' })
    );
  });

  it('proceeds when the auto top-up restores allowance', async () => {
    setup(carved(), makeMember({ allowanceRemainingCredits: 0, autoTopUpMonthlyCredits: 10 }));
    applyAutoTopUp.mockResolvedValue({ moved: 6, balanceAfter: 0, allowanceRemainingAfter: 6 });

    expect((await resolveCharge(memberScope, NOW)).source).toBe('allowance');
  });

  it('does not attempt a top-up when no monthly figure is set', async () => {
    setup(carved(), makeMember({ allowanceRemainingCredits: 0, autoTopUpMonthlyCredits: null }));

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(GroupAllowanceUsedError);
    expect(applyAutoTopUp).not.toHaveBeenCalled();
  });

  it('refuses with the empty-pool message when allowance remains but the pool is empty', async () => {
    setup(carved(), makeMember({ allowanceRemainingCredits: 5 }), 0);

    await expect(resolveCharge(memberScope, NOW)).rejects.toThrow(/credit balance is empty/);
  });
});

describe('resolveCharge: filled allowance (member plan)', () => {
  const filled = (overrides: Partial<GroupWithClock> = {}) =>
    makeGroup({ activityCostsPaidBy: 'allowance', allowanceSource: 'filled', ...overrides });

  it('returns a member plan when the balance is positive', async () => {
    setup(filled(), makeMember({ balanceCredits: 4 }));

    expect(await resolveCharge(memberScope, NOW)).toEqual({
      source: 'member',
      groupId: 'g1',
      memberUserId: 'u1',
    });
    expect(sumMemberOwnSpendSince).not.toHaveBeenCalled();
  });

  it("refuses at or above the monthly cap, measuring spend since the group's month start", async () => {
    setup(filled(), makeMember({ balanceCredits: 4, allowanceCredits: 10 }));
    sumMemberOwnSpendSince.mockResolvedValue(10);

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(GroupMonthlyLimitError);
    expect(sumMemberOwnSpendSince).toHaveBeenCalledWith(
      memberScope,
      'u1',
      new Date('2026-10-10T00:00:00Z')
    );
  });

  it('allows spend under the monthly cap', async () => {
    setup(filled(), makeMember({ balanceCredits: 4, allowanceCredits: 10 }));
    sumMemberOwnSpendSince.mockResolvedValue(9.99);

    expect((await resolveCharge(memberScope, NOW)).source).toBe('member');
  });

  it('under suspend with an empty (zero) balance, refuses with an insufficient-credits error, not a suspension', async () => {
    setup(filled({ shortfallPolicy: 'suspend' }), makeMember({ balanceCredits: 0 }));

    const error = await resolveCharge(memberScope, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error).not.toBeInstanceOf(GroupSuspendedError);
    expect((error as Error).message).toMatch(/Your balance in this group is empty/);
  });

  it('under debt, lets an empty member borrow while the pool can back it', async () => {
    setup(filled(), makeMember({ balanceCredits: 0 }), 1);

    expect((await resolveCharge(memberScope, NOW)).source).toBe('member');
    expect(poolAvailableCredits).toHaveBeenCalledWith(memberScope, 'g1');
  });

  it.each([0, -2])(
    'under debt, refuses an empty member when the pool net of debts is %d',
    async (pool) => {
      setup(filled(), makeMember({ balanceCredits: 0 }), pool);

      await expect(resolveCharge(memberScope, NOW)).rejects.toThrow(/pool cannot cover any more/);
    }
  );

  it("does not read the pool when the member's own balance is positive", async () => {
    setup(filled(), makeMember({ balanceCredits: 1 }), 0);

    await resolveCharge(memberScope, NOW);

    expect(poolAvailableCredits).not.toHaveBeenCalled();
  });

  it("runs the member's auto top-up before judging an empty balance", async () => {
    setup(
      filled({ shortfallPolicy: 'suspend' }),
      makeMember({ balanceCredits: 0, autoTopUpMonthlyCredits: 5 })
    );
    applyAutoTopUp.mockResolvedValue({ moved: 5, balanceAfter: 5, allowanceRemainingAfter: 0 });

    expect((await resolveCharge(memberScope, NOW)).source).toBe('member');
  });
});

describe('resolveCharge: equal_split', () => {
  const split = (overrides: Partial<GroupWithClock> = {}) =>
    makeGroup({ activityCostsPaidBy: 'equal_split', ...overrides });

  it('returns a split plan over admins and members (not viewers)', async () => {
    setup(split(), makeMember({ balanceCredits: 3 }));

    expect(await resolveCharge(memberScope, NOW)).toEqual({
      source: 'split',
      groupId: 'g1',
      roles: ['admin', 'member'],
    });
  });

  it('checks only the starter: an empty starter under suspend is refused', async () => {
    setup(split({ shortfallPolicy: 'suspend' }), makeMember({ balanceCredits: 0 }));

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('refuses a starter in debt under suspend with GroupSuspendedError', async () => {
    setup(split({ shortfallPolicy: 'suspend' }), makeMember({ balanceCredits: -1 }));

    await expect(resolveCharge(memberScope, NOW)).rejects.toBeInstanceOf(GroupSuspendedError);
  });
});

describe('planForRun', () => {
  const adminMember = makeMember({ userId: 'adm', role: 'admin' });

  it('charges an owner scope to the space without reading the group', async () => {
    expect(await planForRun(spaceScope('u1'), 'u1', NOW)).toEqual({ source: 'space' });
    expect(findGroupWithClockBySpaceId).not.toHaveBeenCalled();
  });

  it('charges the space when the space has no group', async () => {
    setup(null, null);

    expect(await planForRun(memberScope, 'u1', NOW)).toEqual({ source: 'space' });
  });

  it('uses the operational plan for a null author: pool by default', async () => {
    setup(makeGroup(), null);

    expect(await planForRun(memberScope, null, NOW)).toEqual({ source: 'space' });
    expect(findJoinedMembership).not.toHaveBeenCalled();
  });

  it('bills a null-author run to a joined admin payer under one_admin', async () => {
    setup(
      makeGroup({ operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'adm' }),
      adminMember
    );

    expect(await planForRun(memberScope, null, NOW)).toEqual({
      source: 'member',
      groupId: 'g1',
      memberUserId: 'adm',
    });
    expect(findJoinedMembership).toHaveBeenCalledWith('g1', 'adm');
  });

  it('falls to the space when the one_admin payer is no longer a joined admin', async () => {
    const group = makeGroup({ operationalCostsPaidBy: 'one_admin', operationalPayerUserId: 'adm' });

    setup(group, makeMember({ userId: 'adm', role: 'member' }));
    expect(await planForRun(memberScope, null, NOW)).toEqual({ source: 'space' });

    setup(group, null);
    expect(await planForRun(memberScope, null, NOW)).toEqual({ source: 'space' });
  });

  it('falls to the space for one_admin with no payer id, without a membership lookup', async () => {
    setup(makeGroup({ operationalCostsPaidBy: 'one_admin', operationalPayerUserId: null }), null);

    expect(await planForRun(memberScope, null, NOW)).toEqual({ source: 'space' });
    expect(findJoinedMembership).not.toHaveBeenCalled();
  });

  it('splits over admins under admins_split', async () => {
    setup(makeGroup({ operationalCostsPaidBy: 'admins_split' }), null);

    expect(await planForRun(memberScope, null, NOW)).toEqual({
      source: 'split',
      groupId: 'g1',
      roles: ['admin'],
    });
  });

  it("bills a former member's run to the space", async () => {
    setup(makeGroup({ activityCostsPaidBy: 'equal_split' }), null);

    expect(await planForRun(memberScope, 'gone', NOW)).toEqual({ source: 'space' });
    expect(findJoinedMembership).toHaveBeenCalledWith('g1', 'gone');
  });

  it('applies the activity plan for a current member and never refuses on an empty balance', async () => {
    setup(
      makeGroup({ activityCostsPaidBy: 'allowance', allowanceSource: 'filled' }),
      makeMember({ balanceCredits: -50 }),
      -50
    );

    expect(await planForRun(memberScope, 'u1', NOW)).toEqual({
      source: 'member',
      groupId: 'g1',
      memberUserId: 'u1',
    });
  });

  it('uses pending settings that have taken effect', async () => {
    setup(
      makeGroup({
        pendingBilling: { ...DEFAULT_GROUP_BILLING, activityCostsPaidBy: 'equal_split' },
        pendingBillingFrom: new Date('2026-10-01T00:00:00Z'),
      }),
      makeMember()
    );

    expect((await planForRun(memberScope, 'u1', NOW)).source).toBe('split');
  });
});

describe('canAffordOperational', () => {
  it('for an owner, is whether the own balance is positive', async () => {
    findCreditAccount.mockResolvedValue({ balanceCredits: 1 });
    expect(await canAffordOperational(spaceScope('u1'), NOW)).toBe(true);

    findCreditAccount.mockResolvedValue(null);
    expect(await canAffordOperational(spaceScope('u1'), NOW)).toBe(false);
  });

  it('with no group row, falls back to the own balance', async () => {
    findGroupWithClockBySpaceId.mockResolvedValue(null);
    findCreditAccount.mockResolvedValue({ balanceCredits: 2 });

    expect(await canAffordOperational(memberScope, NOW)).toBe(true);
  });

  it('under the pool plan, reads the pool net of debts', async () => {
    setup(makeGroup(), null, 1);
    expect(await canAffordOperational(memberScope, NOW)).toBe(true);

    poolAvailableCredits.mockResolvedValue(0);
    expect(await canAffordOperational(memberScope, NOW)).toBe(false);
  });

  describe('one_admin', () => {
    const group = (overrides: Partial<GroupWithClock> = {}) =>
      makeGroup({
        operationalCostsPaidBy: 'one_admin',
        operationalPayerUserId: 'adm',
        ...overrides,
      });
    const admin = (balanceCredits: number, extra: Partial<ResparkableGroupMember> = {}) =>
      makeMember({ userId: 'adm', role: 'admin', balanceCredits, ...extra });

    it('is true when the payer has a positive balance, without touching the pool', async () => {
      setup(group(), admin(3), 0);

      expect(await canAffordOperational(memberScope, NOW)).toBe(true);
      expect(applyAutoTopUp).not.toHaveBeenCalled();
    });

    it('under debt, an empty payer may still run while the pool can lend', async () => {
      setup(group(), admin(0), 5);

      expect(await canAffordOperational(memberScope, NOW)).toBe(true);
    });

    it('under suspend, an empty payer cannot run even with a full pool', async () => {
      setup(group({ shortfallPolicy: 'suspend' }), admin(0), 500);

      expect(await canAffordOperational(memberScope, NOW)).toBe(false);
    });

    it('under debt, an empty payer cannot run when the pool cannot lend', async () => {
      setup(group(), admin(0), 0);

      expect(await canAffordOperational(memberScope, NOW)).toBe(false);
    });

    it("tries the payer's automatic top-up before giving up", async () => {
      setup(group({ shortfallPolicy: 'suspend' }), admin(0, { autoTopUpMonthlyCredits: 10 }));
      applyAutoTopUp.mockResolvedValue({ moved: 10, balanceAfter: 10, allowanceRemainingAfter: 0 });

      expect(await canAffordOperational(memberScope, NOW)).toBe(true);
      expect(applyAutoTopUp).toHaveBeenCalledWith(
        expect.objectContaining({ memberUserId: 'adm', target: 'member' })
      );
    });

    it('is false when the payer has since left (plan falls to pool and the pool is empty)', async () => {
      setup(group(), null, 0);

      expect(await canAffordOperational(memberScope, NOW)).toBe(false);
    });
  });

  describe('admins_split', () => {
    const group = (overrides: Partial<GroupWithClock> = {}) =>
      makeGroup({ operationalCostsPaidBy: 'admins_split', ...overrides });

    it("sums the admins' balances: true when the total is positive even if one is negative", async () => {
      setup(group(), null, 0);
      listJoinedMembersByRole.mockResolvedValue([
        makeMember({ balanceCredits: 5 }),
        makeMember({ balanceCredits: -2 }),
      ]);

      expect(await canAffordOperational(memberScope, NOW)).toBe(true);
      expect(listJoinedMembersByRole).toHaveBeenCalledWith('g1', ['admin']);
    });

    it('is false when the total is not positive and the pool cannot lend', async () => {
      setup(group(), null, 0);
      listJoinedMembersByRole.mockResolvedValue([
        makeMember({ balanceCredits: 1 }),
        makeMember({ balanceCredits: -1 }),
      ]);

      expect(await canAffordOperational(memberScope, NOW)).toBe(false);
    });

    it('is true when admins are empty but the pool can lend under debt', async () => {
      setup(group(), null, 4);
      listJoinedMembersByRole.mockResolvedValue([]);

      expect(await canAffordOperational(memberScope, NOW)).toBe(true);
    });

    it('is false under suspend when the admins are empty, whatever the pool holds', async () => {
      setup(group({ shortfallPolicy: 'suspend' }), null, 400);
      listJoinedMembersByRole.mockResolvedValue([makeMember({ balanceCredits: 0 })]);

      expect(await canAffordOperational(memberScope, NOW)).toBe(false);
    });
  });
});

describe('topUpAutomatically', () => {
  const group = makeGroup({ timezone: 'UTC', createdAt: new Date('2026-01-10T12:00:00Z') });

  it.each([null, 0, -5])('makes no call when the monthly figure is %s', async (monthly) => {
    const membership = makeMember({
      autoTopUpMonthlyCredits: monthly,
      balanceCredits: 2,
      allowanceRemainingCredits: 3,
    });

    const result = await topUpAutomatically(memberScope, group, membership, 'member', NOW);

    expect(result).toEqual({ balanceCredits: 2, allowanceRemainingCredits: 3, moved: 0 });
    expect(applyAutoTopUp).not.toHaveBeenCalled();
  });

  it("passes the group's month start, the personal scope and the target, and reports what moved", async () => {
    applyAutoTopUp.mockResolvedValue({ moved: 4, balanceAfter: 9, allowanceRemainingAfter: 1 });

    const result = await topUpAutomatically(
      memberScope,
      group,
      makeMember({ autoTopUpMonthlyCredits: 8 }),
      'pool_allowance',
      NOW
    );

    expect(result).toEqual({ balanceCredits: 9, allowanceRemainingCredits: 1, moved: 4 });
    expect(applyAutoTopUp).toHaveBeenCalledWith({
      personal: spaceScope('u1'),
      group: memberScope,
      groupId: 'g1',
      memberUserId: 'u1',
      monthlyCredits: 8,
      month: new Date('2026-10-10T00:00:00Z'),
      target: 'pool_allowance',
    });
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { groupId: 'g1', credits: 4 });
  });

  it('does not log when nothing moved', async () => {
    applyAutoTopUp.mockResolvedValue({ moved: 0, balanceAfter: 1, allowanceRemainingAfter: 0 });

    await topUpAutomatically(
      memberScope,
      group,
      makeMember({ autoTopUpMonthlyCredits: 8 }),
      'member',
      NOW
    );

    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([new Error('deadlock'), 'string failure'])(
    'swallows %s, warns, and returns the membership unchanged',
    async (failure) => {
      applyAutoTopUp.mockRejectedValue(failure);

      const result = await topUpAutomatically(
        memberScope,
        group,
        makeMember({
          autoTopUpMonthlyCredits: 8,
          balanceCredits: -1,
          allowanceRemainingCredits: 2,
        }),
        'member',
        NOW
      );

      expect(result).toEqual({ balanceCredits: -1, allowanceRemainingCredits: 2, moved: 0 });
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
        groupId: 'g1',
        error: failure instanceof Error ? failure.message : failure,
      });
    }
  );
});

describe('the month turning over (decision 6)', () => {
  // Created on the 10th, so each month starts at midnight UTC on the 10th.
  const SETTLED_OCT = new Date('2026-10-10T00:00:00Z');

  it('is not due while the current month is the one already settled', () => {
    expect(cycleDue(makeGroup({ cycleSettledThrough: SETTLED_OCT }), NOW)).toBe(false);
  });

  it('is due once a new month has started', () => {
    const group = makeGroup({ cycleSettledThrough: new Date('2026-09-10T00:00:00Z') });
    expect(cycleDue(group, NOW)).toBe(true);
  });

  it('treats a group never settled as settled through the month it was created in', () => {
    const fresh = makeGroup({
      createdAt: new Date('2026-10-12T09:00:00Z'),
      cycleSettledThrough: null,
    });
    expect(cycleDue(fresh, new Date('2026-10-20T00:00:00Z'))).toBe(false);
    expect(cycleDue(fresh, new Date('2026-11-12T00:00:01Z'))).toBe(true);
  });

  it('writes nothing when the month is already settled', async () => {
    const result = await settleGroupCycle(makeGroup({ cycleSettledThrough: SETTLED_OCT }), NOW);

    expect(result).toEqual({ settled: false, seatsCharged: 0, months: 0 });
    expect(settleGroupMonths).not.toHaveBeenCalled();
  });

  it('claims from the value it read, charges the new month’s seat prices, and counts missed months', async () => {
    settleGroupMonths.mockResolvedValue({ settled: true, seatsCharged: 2, shortUserIds: [] });
    const through = new Date('2026-08-10T00:00:00Z');
    const group = makeGroup({
      cycleSettledThrough: through,
      seatPriceMemberCredits: 3,
      seatPriceAdminCredits: 1,
    });

    const result = await settleGroupCycle(group, NOW);

    expect(result).toEqual({ settled: true, seatsCharged: 2, months: 2 });
    expect(settleGroupMonths).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'g1',
        spaceId: 'spc_group',
        expectedThrough: through,
        through: SETTLED_OCT,
        months: 2,
        seatPrices: { admin: 1, member: 3, viewer: 0 },
        creditCarvedAllowances: false,
        promote: null,
      })
    );
  });

  it('applies a change scheduled for the new month to that month’s seats, and promotes it', async () => {
    const pending = {
      ...DEFAULT_GROUP_BILLING,
      seatPriceMemberCredits: 9,
      activityCostsPaidBy: 'allowance' as const,
    };
    const group = makeGroup({
      cycleSettledThrough: new Date('2026-09-10T00:00:00Z'),
      pendingBilling: pending,
      pendingBillingFrom: SETTLED_OCT,
    });

    await settleGroupCycle(group, NOW);

    const input = settleGroupMonths.mock.calls[0]?.[0];
    expect(input.seatPrices.member).toBe(9);
    expect(input.creditCarvedAllowances).toBe(true);
    expect(input.promote).toEqual({ from: SETTLED_OCT, columns: pending });
  });

  it('runs the agreed top-up for a member a seat left below zero', async () => {
    settleGroupMonths.mockResolvedValue({ settled: true, seatsCharged: 1, shortUserIds: ['u1'] });
    findJoinedMembership.mockResolvedValue(
      makeMember({ balanceCredits: -3, autoTopUpMonthlyCredits: 5 })
    );
    applyAutoTopUp.mockResolvedValue({ moved: 5, balanceAfter: 2, allowanceRemainingAfter: 0 });

    await settleGroupCycle(
      makeGroup({ cycleSettledThrough: new Date('2026-09-10T00:00:00Z') }),
      NOW
    );

    expect(applyAutoTopUp).toHaveBeenCalledWith(
      expect.objectContaining({ memberUserId: 'u1', target: 'member', monthlyCredits: 5 })
    );
  });

  it('settles by space for the job, and does nothing for a space with no group', async () => {
    findGroupWithClockBySpaceId.mockResolvedValue(null);
    await expect(settleGroupCycleForSpace('user_a', NOW)).resolves.toEqual({
      settled: false,
      seatsCharged: 0,
      months: 0,
    });
    expect(settleGroupMonths).not.toHaveBeenCalled();
  });

  it('settles an unsettled month before a run is cleared, and a failure there never refuses the run', async () => {
    setup(makeGroup({ cycleSettledThrough: new Date('2026-09-10T00:00:00Z') }), makeMember());
    settleGroupMonths.mockRejectedValue(new Error('db down'));

    await expect(resolveCharge(memberScope, NOW)).resolves.toEqual({ source: 'space' });
    expect(settleGroupMonths).toHaveBeenCalledTimes(1);
  });
});
