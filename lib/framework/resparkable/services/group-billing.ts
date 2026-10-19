/**
 * Who pays in a group (§23.12's second amendment, phase 62).
 *
 * ## The one rule
 *
 * **No charge for a group run ever reads a personal balance.** Every charge
 * comes from an account inside the group: the pool, or a member's own group
 * balance. A personal balance reaches a group only through a transfer the person
 * makes, or an automatic top-up they agreed to and capped themselves.
 *
 * ## A plan, decided before the run
 *
 * {@link resolveCharge} runs before the provider call. It reads the group's
 * settings and returns a {@link ChargePlan} naming one source, or refuses. The
 * debit afterwards takes that plan and nothing else, so a source that ran dry
 * mid-run is never swapped for another one. The billing pass, which bills a
 * workflow run minutes after it started, re-derives the same plan with
 * {@link planForRun}; settings only change at the start of a month (decision 2),
 * so the two agree for every run that does not straddle the month's first
 * minute.
 *
 * See `.context/framework/resparkable/phase-62-plan.md`.
 */

import { z } from 'zod';

import {
  applyAutoTopUp,
  findGroupWithClockBySpaceId,
  findJoinedMembership,
  listJoinedMembersByRole,
  poolAvailableCredits,
  sumMemberOwnSpendSince,
  type AutoTopUpTarget,
  type GroupWithClock,
} from '@/lib/framework/resparkable/repo/group-billing';
import { ensureCreditAccount, findCreditAccount } from '@/lib/framework/resparkable/repo/billing';
import { settleGroupMonths } from '@/lib/framework/resparkable/repo/group-billing-cycle';
import {
  spaceScope,
  spaceScopeFor,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import {
  addZonedMonths,
  instantAtWallClock,
  wallClockAt,
} from '@/lib/framework/resparkable/time/zoned';
import { APIError, ForbiddenError, InsufficientCreditsError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import type { ResparkableGroup, ResparkableGroupMember } from '@prisma/client';

// ─── Settings ────────────────────────────────────────────────────────────────

export const OPERATIONAL_PAYERS = ['pool', 'one_admin', 'admins_split'] as const;
export const ACTIVITY_PAYERS = ['pool', 'equal_split', 'allowance'] as const;
export const ALLOWANCE_SOURCES = ['carved', 'filled'] as const;
export const SHORTFALL_POLICIES = ['debt', 'suspend'] as const;

export type OperationalPayer = (typeof OPERATIONAL_PAYERS)[number];
export type ActivityPayer = (typeof ACTIVITY_PAYERS)[number];
export type AllowanceSource = (typeof ALLOWANCE_SOURCES)[number];
export type ShortfallPolicy = (typeof SHORTFALL_POLICIES)[number];

/** The roles that may start a billed run, and so share an equal split. */
export const SPLIT_ROLES = ['admin', 'member'] as const;

/**
 * Everything an admin decides about who pays. Stored as columns on the group,
 * and as one JSON value (`pendingBilling`) while a change waits for next month.
 */
export const groupBillingSettingsSchema = z.object({
  seatPriceAdminCredits: z.number().finite().min(0),
  seatPriceMemberCredits: z.number().finite().min(0),
  seatPriceViewerCredits: z.number().finite().min(0),
  operationalCostsPaidBy: z.enum(OPERATIONAL_PAYERS),
  operationalPayerUserId: z.string().min(1).nullable(),
  activityCostsPaidBy: z.enum(ACTIVITY_PAYERS),
  allowanceSource: z.enum(ALLOWANCE_SOURCES),
  shortfallPolicy: z.enum(SHORTFALL_POLICIES),
});

export type GroupBillingSettings = z.infer<typeof groupBillingSettingsSchema>;

/** Phase 50's behaviour: the pool pays for everything, nobody pays a seat. */
export const DEFAULT_GROUP_BILLING: GroupBillingSettings = {
  seatPriceAdminCredits: 0,
  seatPriceMemberCredits: 0,
  seatPriceViewerCredits: 0,
  operationalCostsPaidBy: 'pool',
  operationalPayerUserId: null,
  activityCostsPaidBy: 'pool',
  allowanceSource: 'carved',
  shortfallPolicy: 'debt',
};

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * The settings in the group's columns. An unrecognised string reads as the
 * default, never as something that charges a member: the defaults are the ones
 * that read only the pool.
 */
export function storedBillingSettings(group: ResparkableGroup): GroupBillingSettings {
  return {
    seatPriceAdminCredits: Math.max(0, group.seatPriceAdminCredits),
    seatPriceMemberCredits: Math.max(0, group.seatPriceMemberCredits),
    seatPriceViewerCredits: Math.max(0, group.seatPriceViewerCredits),
    operationalCostsPaidBy: oneOf(OPERATIONAL_PAYERS, group.operationalCostsPaidBy, 'pool'),
    operationalPayerUserId: group.operationalPayerUserId,
    activityCostsPaidBy: oneOf(ACTIVITY_PAYERS, group.activityCostsPaidBy, 'pool'),
    allowanceSource: oneOf(ALLOWANCE_SOURCES, group.allowanceSource, 'carved'),
    shortfallPolicy: oneOf(SHORTFALL_POLICIES, group.shortfallPolicy, 'debt'),
  };
}

/**
 * The settings in force at `now`.
 *
 * A pending change is read **lazily**: once `pendingBillingFrom` has passed, the
 * pending values are the group's settings whether or not the monthly cycle has
 * copied them into the columns yet. So a late cycle job can never bill a run
 * under last month's rules.
 */
export function effectiveBillingSettings(
  group: ResparkableGroup,
  now: Date = new Date()
): GroupBillingSettings {
  if (group.pendingBillingFrom && group.pendingBillingFrom <= now && group.pendingBilling) {
    const parsed = groupBillingSettingsSchema.safeParse(group.pendingBilling);
    if (parsed.success) return parsed.data;
    logger.warn('Resparkable group pending billing settings unreadable; using stored', {
      groupId: group.id,
    });
  }
  return storedBillingSettings(group);
}

/** A role's seat price under these settings. */
export function seatPriceFor(settings: GroupBillingSettings, role: string): number {
  if (role === 'admin') return settings.seatPriceAdminCredits;
  if (role === 'viewer') return settings.seatPriceViewerCredits;
  return settings.seatPriceMemberCredits;
}

// ─── The group's month ───────────────────────────────────────────────────────

/** The 29th, 30th and 31st do not exist every month, so they fold to the 28th. */
const LAST_ANCHOR_DAY = 28;

/**
 * The start of the group's month containing `now`: midnight on the day of the
 * month the group was created (folded to the 28th), on the group's clock.
 */
export function monthStartFor(
  group: Pick<ResparkableGroup, 'createdAt'>,
  timeZone: string,
  now: Date = new Date()
): Date {
  const anchor = Math.min(wallClockAt(group.createdAt, timeZone).day, LAST_ANCHOR_DAY);
  const wall = wallClockAt(now, timeZone);
  const thisMonths = instantAtWallClock(
    { year: wall.year, month: wall.month, day: anchor, hour: 0, minute: 0, second: 0 },
    timeZone
  );
  // Anchors stop at the 28th, so stepping back a month never clamps.
  return thisMonths <= now ? thisMonths : addZonedMonths(thisMonths, -1, timeZone);
}

/** The start of the group's next month. */
export function nextMonthStartFor(
  group: Pick<ResparkableGroup, 'createdAt'>,
  timeZone: string,
  now: Date = new Date()
): Date {
  return addZonedMonths(monthStartFor(group, timeZone, now), 1, timeZone);
}

// ─── The month turning over ──────────────────────────────────────────────────

/** A job that is years late settles at most this many months at once. */
const MAX_MONTHS_AT_ONCE = 24;

/** The month a group's settlement has reached: its own column, or its first month. */
function settledThrough(group: GroupWithClock): Date {
  return group.cycleSettledThrough ?? monthStartFor(group, group.timezone, group.createdAt);
}

/** Whether a new month has started that this group has not settled. Pure. */
export function cycleDue(group: GroupWithClock, now: Date = new Date()): boolean {
  return monthStartFor(group, group.timezone, now) > settledThrough(group);
}

/**
 * Settle the start of the group's month, once (decision 6): promote a pending
 * settings change, add carved allowances, charge each member their seat.
 *
 * **Idempotent and safe to call from anywhere.** The repo's claim lets exactly
 * one caller settle a given month; everybody else gets `settled: false`. It is
 * called by the daily `group_cycle` job and lazily by {@link resolveCharge}, so
 * a late job can never let a run be charged under last month's allowance.
 *
 * **The month a member joins in is free.** Seats are charged at each month's
 * start to whoever is in the group then, so a member's first seat is their first
 * full month. A pro-rata charge on joining would need its own consent step in
 * all three ways in (an invitation, an open link, an approved request), and
 * would put somebody with no group balance yet straight into debt on day one.
 */
export async function settleGroupCycle(
  group: GroupWithClock,
  now: Date = new Date()
): Promise<{ settled: boolean; seatsCharged: number; months: number }> {
  const through = monthStartFor(group, group.timezone, now);
  const from = settledThrough(group);
  if (through <= from) return { settled: false, seatsCharged: 0, months: 0 };

  let months = 0;
  for (let cursor = from; cursor < through && months < MAX_MONTHS_AT_ONCE; months++) {
    cursor = addZonedMonths(cursor, 1, group.timezone);
  }

  // The settings in force in the new month: a change scheduled for it applies
  // to its seats, which is the whole point of scheduling it.
  const settings = effectiveBillingSettings(group, through);
  const promote = group.pendingBillingFrom && group.pendingBillingFrom <= through ? settings : null;

  const result = await settleGroupMonths({
    groupId: group.id,
    spaceId: group.spaceId,
    expectedThrough: group.cycleSettledThrough,
    through,
    months,
    seatPrices: {
      admin: settings.seatPriceAdminCredits,
      member: settings.seatPriceMemberCredits,
      viewer: settings.seatPriceViewerCredits,
    },
    creditCarvedAllowances:
      settings.activityCostsPaidBy === 'allowance' && settings.allowanceSource === 'carved',
    promote:
      promote && group.pendingBillingFrom
        ? { from: group.pendingBillingFrom, columns: promote }
        : null,
  });

  if (result.settled) {
    logger.info('Resparkable group month settled', {
      groupId: group.id,
      months,
      seatsCharged: result.seatsCharged,
    });
    // A seat that left somebody below zero runs their agreed top-up, best effort.
    const scope = spaceScopeFor({ spaceId: group.spaceId, actorUserId: null, role: 'member' });
    for (const userId of result.shortUserIds) {
      const membership = await findJoinedMembership(group.id, userId);
      if (membership) await topUpAutomatically(scope, group, membership, 'member', now);
    }
  }
  return { settled: result.settled, seatsCharged: result.seatsCharged, months };
}

/** {@link settleGroupCycle} for the queue's `group_cycle` job, by space. */
export async function settleGroupCycleForSpace(
  spaceId: string,
  now: Date = new Date()
): Promise<{ settled: boolean; seatsCharged: number; months: number }> {
  const group = await findGroupWithClockBySpaceId(spaceId);
  if (!group) return { settled: false, seatsCharged: 0, months: 0 };
  return settleGroupCycle(group, now);
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** A member below zero in a group that cuts people off until they pay. */
export class GroupSuspendedError extends APIError {
  constructor(owedCredits: number) {
    super(
      `You owe this group ${Math.round(owedCredits * 100) / 100} credits. Top up your balance in the group to carry on.`,
      'GROUP_ACCESS_SUSPENDED',
      402
    );
    this.name = 'GroupSuspendedError';
  }
}

/** A member who has used this month's carved allowance. */
export class GroupAllowanceUsedError extends APIError {
  constructor() {
    super(
      'You have used your allowance in this group for this month. It is topped up at the start of next month.',
      'GROUP_ALLOWANCE_USED',
      402
    );
    this.name = 'GroupAllowanceUsedError';
  }
}

/** A member who has spent this month's limit of their own money in the group. */
export class GroupMonthlyLimitError extends APIError {
  constructor() {
    super(
      'You have reached the most this group lets you spend in a month. It resets at the start of next month.',
      'GROUP_MONTHLY_LIMIT_REACHED',
      402
    );
    this.name = 'GroupMonthlyLimitError';
  }
}

const POOL_EMPTY = "This group's credit balance is empty. A group admin can top it up.";
const OWN_BALANCE_EMPTY =
  'Your balance in this group is empty. Top it up to carry on, or ask an admin how the group pays.';
const CANNOT_LEND =
  "Your balance in this group is empty, and the group's pool cannot cover any more. Top up your balance in the group to carry on.";

// ─── Plans ───────────────────────────────────────────────────────────────────

/** The one source a run is charged to, decided before it starts. */
export type ChargePlan =
  /** The space's own account: a personal balance, or a group's pool. */
  | { source: 'space' }
  /** The pool, counted against this member's carved allowance. */
  | { source: 'allowance'; groupId: string; memberUserId: string }
  /** One member's own group balance. */
  | { source: 'member'; groupId: string; memberUserId: string }
  /** Equal shares over the joined members holding `roles`. */
  | { source: 'split'; groupId: string; roles: readonly string[] };

const SPACE: ChargePlan = { source: 'space' };

/**
 * The operational plan: who pays for runs nobody started. A `one_admin` payer
 * who is no longer a joined admin reads as the pool, so the digest never
 * charges somebody who has left or been demoted.
 */
async function operationalPlan(
  group: GroupWithClock,
  settings: GroupBillingSettings
): Promise<ChargePlan> {
  if (settings.operationalCostsPaidBy === 'admins_split') {
    return { source: 'split', groupId: group.id, roles: ['admin'] };
  }
  if (settings.operationalCostsPaidBy === 'one_admin' && settings.operationalPayerUserId) {
    const payer = await findJoinedMembership(group.id, settings.operationalPayerUserId);
    if (payer?.role === 'admin') {
      return { source: 'member', groupId: group.id, memberUserId: payer.userId };
    }
  }
  return SPACE;
}

/** The activity plan for a member, with no checks. */
function activityPlan(
  group: GroupWithClock,
  settings: GroupBillingSettings,
  memberUserId: string
): ChargePlan {
  switch (settings.activityCostsPaidBy) {
    case 'equal_split':
      return { source: 'split', groupId: group.id, roles: SPLIT_ROLES };
    case 'allowance':
      return settings.allowanceSource === 'filled'
        ? { source: 'member', groupId: group.id, memberUserId }
        : { source: 'allowance', groupId: group.id, memberUserId };
    default:
      return SPACE;
  }
}

/**
 * The plan for a run that has already happened, for the billing pass. Never
 * refuses: the cost is real by now.
 *
 * `authorUserId` null is an operational run. An author who is no longer a member
 * is billed to the pool: a switch of account, but not on an empty balance, and
 * the alternative is a run nobody pays for (phase-62-plan.md, known edges).
 */
export async function planForRun(
  scope: SpaceScope,
  authorUserId: string | null,
  now: Date = new Date()
): Promise<ChargePlan> {
  if (scope.role === 'owner') return SPACE;
  const group = await findGroupWithClockBySpaceId(scope.spaceId);
  if (!group) return SPACE;
  const settings = effectiveBillingSettings(group, now);
  if (!authorUserId) return operationalPlan(group, settings);
  const membership = await findJoinedMembership(group.id, authorUserId);
  if (!membership) return SPACE;
  return activityPlan(group, settings, authorUserId);
}

// ─── Pre-flight ──────────────────────────────────────────────────────────────

/**
 * Run the member's agreed automatic top-up if they have one. Returns the
 * membership as it stands afterwards. Never throws: a top-up that could not
 * happen is the same as no top-up, and the refusal that follows says why.
 */
export async function topUpAutomatically(
  scope: SpaceScope,
  group: GroupWithClock,
  membership: ResparkableGroupMember,
  target: AutoTopUpTarget,
  now: Date = new Date()
): Promise<{ balanceCredits: number; allowanceRemainingCredits: number; moved: number }> {
  const unchanged = {
    balanceCredits: membership.balanceCredits,
    allowanceRemainingCredits: membership.allowanceRemainingCredits,
    moved: 0,
  };
  const monthly = membership.autoTopUpMonthlyCredits;
  if (monthly === null || monthly <= 0) return unchanged;
  try {
    const result = await applyAutoTopUp({
      personal: spaceScope(membership.userId),
      group: scope,
      groupId: group.id,
      memberUserId: membership.userId,
      monthlyCredits: monthly,
      month: monthStartFor(group, group.timezone, now),
      target,
    });
    if (result.moved > 0) {
      logger.info('Resparkable group automatic top-up', {
        groupId: group.id,
        credits: result.moved,
      });
    }
    return {
      balanceCredits: result.balanceAfter,
      allowanceRemainingCredits: result.allowanceRemainingAfter,
      moved: result.moved,
    };
  } catch (error) {
    logger.warn('Resparkable group automatic top-up failed', {
      groupId: group.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return unchanged;
  }
}

/**
 * Can this member start a run paid from their own group balance?
 *
 * Above zero: yes. At or below zero, after their automatic top-up: under
 * `suspend`, no; under `debt`, yes while the pool can back the debt
 * ({@link poolAvailableCredits}), because an unpaid debt lands on the pool and
 * borrowing it is borrowing from the pool. That is also what bounds the
 * operator's exposure: borrowing stops when the group cannot cover it.
 */
async function assertMemberCanPay(
  scope: SpaceScope,
  group: GroupWithClock,
  settings: GroupBillingSettings,
  membership: ResparkableGroupMember,
  now: Date
): Promise<void> {
  let balance = membership.balanceCredits;
  if (balance <= 0) {
    balance = (await topUpAutomatically(scope, group, membership, 'member', now)).balanceCredits;
  }
  if (balance > 0) return;
  if (settings.shortfallPolicy === 'suspend') {
    if (balance < 0) throw new GroupSuspendedError(-balance);
    throw new InsufficientCreditsError(OWN_BALANCE_EMPTY);
  }
  if ((await poolAvailableCredits(scope, group.id)) > 0) return;
  throw new InsufficientCreditsError(CANNOT_LEND);
}

/**
 * Decide who pays for a run a person is about to start, or refuse, before any
 * provider call (§23.12). Returns the plan the debit afterwards must use.
 *
 * A personal space and a group whose pool pays behave exactly as phase 50 did,
 * except that a group's pool is read net of its members' debts.
 */
export async function resolveCharge(
  scope: SpaceScope,
  now: Date = new Date()
): Promise<ChargePlan> {
  if (scope.role === 'viewer') {
    throw new ForbiddenError('Viewers cannot use features that spend credits');
  }

  if (scope.role === 'owner') {
    // `ensure`, not `find`: lazily backfills a pre-phase-29 space at zero
    // rather than failing on a missing row.
    const account = await ensureCreditAccount(scope);
    if (account.balanceCredits <= 0) throw new InsufficientCreditsError();
    return SPACE;
  }

  const group = await findGroupWithClockBySpaceId(scope.spaceId);
  if (!group || !scope.actorUserId) {
    // A group-role scope with no group or no person behind it is a background
    // pass; the queue's gate is what answers for those.
    if (((await findCreditAccount(scope))?.balanceCredits ?? 0) > 0) return SPACE;
    throw new InsufficientCreditsError(POOL_EMPTY);
  }

  // A new month nobody has settled yet: settle it first, so this run sees this
  // month's allowance and seat, not last month's. Never refuses a run itself.
  if (cycleDue(group, now)) {
    await settleGroupCycle(group, now).catch((error: unknown) => {
      logger.warn('Resparkable group month could not be settled before a run', {
        groupId: group.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const settings = effectiveBillingSettings(group, now);
  const membership = await findJoinedMembership(group.id, scope.actorUserId);
  if (!membership) throw new ForbiddenError('You are not a member of this group');

  // Suspended means suspended whoever pays: a member cut off for a debt cannot
  // start a run even in a group whose pool pays for runs.
  if (settings.shortfallPolicy === 'suspend' && membership.balanceCredits < 0) {
    const after = await topUpAutomatically(scope, group, membership, 'member', now);
    if (after.balanceCredits < 0) throw new GroupSuspendedError(-after.balanceCredits);
  }

  const plan = activityPlan(group, settings, scope.actorUserId);
  switch (plan.source) {
    case 'space':
      if ((await poolAvailableCredits(scope, group.id)) <= 0) {
        throw new InsufficientCreditsError(POOL_EMPTY);
      }
      break;
    case 'allowance': {
      let remaining = membership.allowanceRemainingCredits;
      if (remaining <= 0) {
        remaining = (await topUpAutomatically(scope, group, membership, 'pool_allowance', now))
          .allowanceRemainingCredits;
      }
      if (remaining <= 0) throw new GroupAllowanceUsedError();
      if ((await poolAvailableCredits(scope, group.id)) <= 0) {
        throw new InsufficientCreditsError(POOL_EMPTY);
      }
      break;
    }
    case 'member': {
      await assertMemberCanPay(scope, group, settings, membership, now);
      if (membership.allowanceCredits !== null) {
        const since = monthStartFor(group, group.timezone, now);
        const spent = await sumMemberOwnSpendSince(scope, scope.actorUserId, since);
        if (spent >= membership.allowanceCredits) throw new GroupMonthlyLimitError();
      }
      break;
    }
    case 'split':
      await assertMemberCanPay(scope, group, settings, membership, now);
      break;
  }
  return plan;
}

/**
 * Can a group afford a run nobody started? The queue's gate for the digest.
 * Non-throwing. Under `debt`, a payer at zero may still run it while the pool
 * can back the debt, exactly as a member may.
 */
export async function canAffordOperational(
  scope: SpaceScope,
  now: Date = new Date()
): Promise<boolean> {
  const ownBalance = async () => ((await findCreditAccount(scope))?.balanceCredits ?? 0) > 0;
  if (scope.role === 'owner') return ownBalance();
  const group = await findGroupWithClockBySpaceId(scope.spaceId);
  if (!group) return ownBalance();
  const settings = effectiveBillingSettings(group, now);
  const plan = await operationalPlan(group, settings);
  const poolCanLend = async () =>
    settings.shortfallPolicy === 'debt' && (await poolAvailableCredits(scope, group.id)) > 0;

  if (plan.source === 'member') {
    const payer = await findJoinedMembership(group.id, plan.memberUserId);
    if (!payer) return false;
    const after =
      payer.balanceCredits > 0
        ? payer
        : await topUpAutomatically(scope, group, payer, 'member', now);
    return after.balanceCredits > 0 || (await poolCanLend());
  }
  if (plan.source === 'split') {
    const admins = await listJoinedMembersByRole(group.id, plan.roles);
    const total = admins.reduce((sum, admin) => sum + admin.balanceCredits, 0);
    return total > 0 || (await poolCanLend());
  }
  return (await poolAvailableCredits(scope, group.id)) > 0;
}
