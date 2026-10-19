/**
 * A group's budget (§23.12, phase 50): who may fill it, how it is capped, who
 * hears when it runs low, and which screen each half of the money lands on.
 *
 * ## Recording spend is not the same as capping it
 *
 * The pre-flight (`assertCanSpend` in `services/billing.ts`) is what refuses a
 * run. This file is the rest of the policy: the funding mode, the top-up, the
 * per-member cap an admin sets, the two admin-only alerts, and the budget view.
 *
 * ## An admin sees spend, and nobody sees productivity
 *
 * Every member sees the group's balance, because hiding it produces refusals
 * nobody can explain. Only an admin sees who spent and who contributed. A
 * member's view carries their own cap and their own day's spend against it,
 * which is about them, and nothing about anybody else (23.8).
 *
 * ## The funding mode moves credits, never reads them
 *
 * `self_funded`: admins top the balance up. `member_contributions`: any member
 * may. Both are one-way transfers from the giver's personal balance that the
 * giver makes on purpose. Neither touches spend time, where exactly one account
 * is read, the group's, and an empty one is a refusal rather than a fallback.
 */

import {
  GroupBudgetAlertEmail,
  groupBudgetAlertSubject,
  type GroupBudgetAlertKind,
} from '@/components/resparkable/emails/group-budget-alert';
import {
  ensureCreditAccount,
  findCreditAccount,
  sumMemberSpendSince,
  summariseLedgerByMemberSince,
  transferCreditsToGroup,
} from '@/lib/framework/resparkable/repo/billing';
import {
  claimLargeRunAlert,
  findGroupById,
  findGroupBySpaceId,
  releaseLargeRunAlert,
  listGroupMembers,
  listMemberContacts,
  updateGroup,
  updateMemberDailyCreditCap,
} from '@/lib/framework/resparkable/repo/groups';
import { spaceScope, type SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  permissionsFor,
  resolveGroupMembership,
} from '@/lib/framework/resparkable/services/membership';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { recordGroupAudit } from '@/lib/framework/resparkable/services/group-audit';
import {
  clearPendingBilling,
  promotePendingBilling,
  releaseOperationalPayer,
  setPendingBilling,
  transferCreditsToMemberBalance,
  updateMemberAllowance,
  updateMemberAutoTopUp,
} from '@/lib/framework/resparkable/repo/group-billing-settings';
import {
  findGroupWithClockBySpaceId,
  findJoinedMembership,
} from '@/lib/framework/resparkable/repo/group-billing';
import {
  effectiveBillingSettings,
  monthStartFor,
  nextMonthStartFor,
  storedBillingSettings,
  type GroupBillingSettings,
} from '@/lib/framework/resparkable/services/group-billing';
import { logger } from '@/lib/logging';

export const FUNDING_MODES = ['self_funded', 'member_contributions'] as const;
export type FundingMode = (typeof FUNDING_MODES)[number];

export function isFundingMode(value: string): value is FundingMode {
  return (FUNDING_MODES as readonly string[]).includes(value);
}

/** The window per-person figures cover in the admin view. */
export const MEMBER_SPEND_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The window a member's `dailyCreditCap` is measured over. Rolling, not
 * calendar. One constant for the pre-flight (`assertCanSpend`) and the budget
 * screen's "used in the last 24 hours", so the two can never disagree.
 */
export const DAILY_CAP_WINDOW_MS = DAY_MS;

/** Smaller than any credit amount that matters, larger than float noise. */
const CREDIT_EPSILON = 1e-6;

/** The large-run alert goes out at most once in this window, per group. */
const LARGE_RUN_ALERT_WINDOW_MS = DAY_MS;

/** Why a budget change was refused. The route turns each into a status. */
export type BudgetRefusal =
  | 'not_a_member'
  | 'not_an_admin'
  | 'no_such_member'
  /** A member tried to top up a self-funded group, or a viewer tried at all. */
  | 'top_up_not_allowed'
  /** The giver's own balance does not cover the amount. */
  | 'insufficient_personal_credits'
  /** `one_admin` named somebody who is not a joined admin (phase 62). */
  | 'payer_not_admin';

export type BudgetResult<T> = { ok: true; value: T } | { ok: false; reason: BudgetRefusal };

export interface GroupBudgetView {
  balanceCredits: number;
  fundingMode: FundingMode;
  /** Whether the caller may top the group up under its funding mode. */
  canTopUp: boolean;
  /** The caller's own personal balance, which is what a top-up comes out of. */
  yourPersonalBalanceCredits: number;
  /**
   * The caller's own figures: their daily cap and spend against it, and their
   * money in the group (phase 62). `suspended` is derived, never stored.
   */
  you: {
    dailyCreditCap: number | null;
    spentLastDayCredits: number;
    balanceCredits: number;
    allowanceCredits: number | null;
    allowanceRemainingCredits: number;
    autoTopUpMonthlyCredits: number | null;
    autoTopUpUsedThisMonthCredits: number;
    suspended: boolean;
  };
  /**
   * Who pays (phase 62), shown to every member: the settings in force, a change
   * waiting for next month if there is one, and when this month started.
   */
  billing: {
    settings: GroupBillingSettings;
    pending: { settings: GroupBillingSettings; from: string } | null;
    monthStartedAt: string;
    nextMonthStartsAt: string;
  };
  /** Admins only. `null` for everybody else, never an empty object. */
  admin: {
    lowBalanceAlertCredits: number | null;
    largeRunAlertPercent: number | null;
    windowDays: number;
    members: Array<{
      userId: string;
      role: string;
      dailyCreditCap: number | null;
      spentCredits: number;
      contributedCredits: number;
    }>;
  } | null;
}

/** A member of the right role may top up under the group's funding mode. */
function mayTopUp(role: string, fundingMode: string): boolean {
  if (role === 'admin') return true;
  return role === 'member' && fundingMode === 'member_contributions';
}

/** Rounded for display and email. The ledger keeps the exact figures. */
function round(credits: number): number {
  return Math.round(credits * 100) / 100;
}

export async function getGroupBudget(
  actorUserId: string,
  groupId: string,
  now: Date = new Date()
): Promise<BudgetResult<GroupBudgetView>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };

  const { membership, scope } = resolved;
  const group = membership.group;
  const fundingMode: FundingMode = isFundingMode(group.fundingMode)
    ? group.fundingMode
    : 'self_funded';
  const isAdmin = permissionsFor(scope.role).administer;

  const [account, personal, spentLastDay] = await Promise.all([
    findCreditAccount(scope),
    findCreditAccount(spaceScope(actorUserId)),
    sumMemberSpendSince(scope, actorUserId, new Date(now.getTime() - DAILY_CAP_WINDOW_MS)),
  ]);

  let admin: GroupBudgetView['admin'] = null;
  if (isAdmin) {
    const since = new Date(now.getTime() - MEMBER_SPEND_WINDOW_DAYS * DAY_MS);
    const [members, summaries] = await Promise.all([
      listGroupMembers(groupId),
      summariseLedgerByMemberSince(scope, since),
    ]);
    const byUser = new Map(summaries.map((row) => [row.userId, row]));
    admin = {
      lowBalanceAlertCredits: group.lowBalanceAlertCredits,
      largeRunAlertPercent: group.largeRunAlertPercent,
      windowDays: MEMBER_SPEND_WINDOW_DAYS,
      members: members
        .filter((member) => member.joinedAt !== null)
        .map((member) => ({
          userId: member.userId,
          role: member.role,
          dailyCreditCap: member.dailyCreditCap,
          spentCredits: round(byUser.get(member.userId)?.spentCredits ?? 0),
          contributedCredits: round(byUser.get(member.userId)?.contributedCredits ?? 0),
        })),
    };
  }

  const clock = await findGroupWithClockBySpaceId(scope.spaceId);
  const timeZone = clock?.timezone ?? 'UTC';
  const settings = effectiveBillingSettings(group, now);
  const monthStart = monthStartFor(group, timeZone, now);
  const pendingWaiting =
    group.pendingBillingFrom !== null && group.pendingBillingFrom > now
      ? {
          settings: effectiveBillingSettings(group, group.pendingBillingFrom),
          from: group.pendingBillingFrom.toISOString(),
        }
      : null;
  const usedThisMonth =
    membership.autoTopUpMonth?.getTime() === monthStart.getTime()
      ? membership.autoTopUpUsedCredits
      : 0;

  return {
    ok: true,
    value: {
      balanceCredits: round(account?.balanceCredits ?? 0),
      fundingMode,
      canTopUp: mayTopUp(scope.role, fundingMode),
      yourPersonalBalanceCredits: round(personal?.balanceCredits ?? 0),
      you: {
        dailyCreditCap: membership.dailyCreditCap,
        spentLastDayCredits: round(spentLastDay),
        balanceCredits: round(membership.balanceCredits),
        allowanceCredits: membership.allowanceCredits,
        allowanceRemainingCredits: round(membership.allowanceRemainingCredits),
        autoTopUpMonthlyCredits: membership.autoTopUpMonthlyCredits,
        autoTopUpUsedThisMonthCredits: round(usedThisMonth),
        suspended: settings.shortfallPolicy === 'suspend' && membership.balanceCredits < 0,
      },
      billing: {
        settings,
        pending: pendingWaiting,
        monthStartedAt: monthStart.toISOString(),
        nextMonthStartsAt: nextMonthStartFor(group, timeZone, now).toISOString(),
      },
      admin,
    },
  };
}

export interface GroupBudgetSettingsInput {
  fundingMode?: FundingMode;
  lowBalanceAlertCredits?: number | null;
  largeRunAlertPercent?: number | null;
}

/** Change the funding mode or the alerts. Admin only. */
export async function updateGroupBudgetSettings(
  actorUserId: string,
  groupId: string,
  input: GroupBudgetSettingsInput
): Promise<BudgetResult<GroupBudgetSettingsInput>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) return { ok: false, reason: 'not_an_admin' };

  const updated = await updateGroup(groupId, input);
  await recordGroupAudit({
    groupId,
    actorUserId,
    action: 'budget_changed',
    metadata: {
      fundingMode: updated.fundingMode,
      lowBalanceAlertCredits: updated.lowBalanceAlertCredits,
      largeRunAlertPercent: updated.largeRunAlertPercent,
    },
  });
  return {
    ok: true,
    value: {
      fundingMode: isFundingMode(updated.fundingMode) ? updated.fundingMode : 'self_funded',
      lowBalanceAlertCredits: updated.lowBalanceAlertCredits,
      largeRunAlertPercent: updated.largeRunAlertPercent,
    },
  };
}

/**
 * Set or clear one member's daily cap. Admin only, and an admin may cap
 * themselves: the cap is a blast-radius limit, not a judgement of anybody.
 */
export async function setMemberDailyCreditCap(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  dailyCreditCap: number | null
): Promise<BudgetResult<{ userId: string; dailyCreditCap: number | null }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) return { ok: false, reason: 'not_an_admin' };

  const updated = await updateMemberDailyCreditCap(groupId, targetUserId, dailyCreditCap);
  if (!updated) return { ok: false, reason: 'no_such_member' };
  await recordGroupAudit({
    groupId,
    actorUserId,
    subjectUserId: targetUserId,
    action: 'member_cap_changed',
    metadata: { dailyCreditCap },
  });
  return { ok: true, value: { userId: targetUserId, dailyCreditCap } };
}

/**
 * Move credits from the caller's own balance into the group's.
 *
 * Who may: an admin always; a member when the group takes member
 * contributions; a viewer never. The money is the caller's to give, so the
 * amount comes out of their personal balance and nobody else's, and a balance
 * that does not cover it is a refusal with nothing written.
 */
export async function topUpGroup(
  actorUserId: string,
  groupId: string,
  credits: number
): Promise<BudgetResult<{ balanceCredits: number }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };

  const { membership, scope } = resolved;
  if (!mayTopUp(scope.role, membership.group.fundingMode)) {
    return { ok: false, reason: 'top_up_not_allowed' };
  }

  // The giver's own brain may not exist yet (a person who joined through a
  // group invite and has only ever opened the group), and a credit account
  // cannot exist without it.
  await ensureResparkableSpace(actorUserId);
  const personal = spaceScope(actorUserId);
  await ensureCreditAccount(personal);

  const moved = await transferCreditsToGroup(
    personal,
    scope,
    credits,
    `Top-up to ${membership.group.name}`.slice(0, 500)
  );
  if (!moved) return { ok: false, reason: 'insufficient_personal_credits' };

  logger.info('Resparkable group topped up', { groupId, credits });
  await recordGroupAudit({ groupId, actorUserId, action: 'topped_up', metadata: { credits } });
  return { ok: true, value: { balanceCredits: round(moved.groupBalanceCredits) } };
}

// ─── Who pays (phase 62) ──────────────────────────────────────────────────────

export type GroupBillingChange = Partial<GroupBillingSettings>;

export interface GroupBillingChangeView {
  settings: GroupBillingSettings;
  pending: { settings: GroupBillingSettings; from: string } | null;
}

/**
 * Change who pays. Admin only, and **never at once**: the change waits for the
 * start of the group's next month, and every member can see it waiting
 * (decided 2026-10-19). A member who joined a group where the pool paid for
 * their chats is told before their own balance is charged, and no run is billed
 * under a rule that changed after it started.
 *
 * A second change in the same month replaces the first (merged over it, so a
 * change to seat prices does not undo a waiting change to who pays). A change
 * whose start has already passed is promoted into the columns first, so it is
 * never lost under the new one. `discardPending` drops a change still waiting.
 */
export async function updateGroupBilling(
  actorUserId: string,
  groupId: string,
  change: GroupBillingChange,
  options: { discardPending?: boolean } = {},
  now: Date = new Date()
): Promise<BudgetResult<GroupBillingChangeView>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) return { ok: false, reason: 'not_an_admin' };

  let group = resolved.membership.group;
  const clock = await findGroupWithClockBySpaceId(group.spaceId);
  const timeZone = clock?.timezone ?? 'UTC';

  if (group.pendingBillingFrom && group.pendingBillingFrom <= now) {
    await promotePendingBilling(
      groupId,
      group.pendingBillingFrom,
      effectiveBillingSettings(group, now),
      now
    );
    group = (await findGroupBySpaceId(group.spaceId)) ?? group;
  }

  if (options.discardPending) {
    if (group.pendingBillingFrom) {
      group = await clearPendingBilling(groupId);
      await recordGroupAudit({
        groupId,
        actorUserId,
        action: 'billing_changed',
        metadata: { discarded: true },
      });
    }
    return { ok: true, value: { settings: storedBillingSettings(group), pending: null } };
  }

  const base =
    group.pendingBillingFrom !== null
      ? effectiveBillingSettings(group, group.pendingBillingFrom)
      : storedBillingSettings(group);
  const next: GroupBillingSettings = { ...base, ...change };
  if (next.operationalCostsPaidBy !== 'one_admin') next.operationalPayerUserId = null;
  if (next.operationalCostsPaidBy === 'one_admin') {
    const payer = next.operationalPayerUserId
      ? await findJoinedMembership(groupId, next.operationalPayerUserId)
      : null;
    if (payer?.role !== 'admin') return { ok: false, reason: 'payer_not_admin' };
  }

  const from = nextMonthStartFor(group, timeZone, now);
  group = await setPendingBilling(groupId, next, from);
  await recordGroupAudit({
    groupId,
    actorUserId,
    action: 'billing_changed',
    metadata: { ...change, from: from.toISOString() },
  });
  logger.info('Resparkable group billing change scheduled', {
    groupId,
    fields: Object.keys(change),
  });
  return {
    ok: true,
    value: {
      settings: storedBillingSettings(group),
      pending: { settings: next, from: from.toISOString() },
    },
  };
}

/**
 * Set or clear one member's monthly allowance. Admin only. Under a carved
 * allowance it is what is added to their share of the pool each month; under a
 * filled one, the most of their own money they may spend in the group a month.
 */
export async function setMemberAllowance(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  allowanceCredits: number | null
): Promise<BudgetResult<{ userId: string; allowanceCredits: number | null }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) return { ok: false, reason: 'not_an_admin' };

  if (!(await updateMemberAllowance(groupId, targetUserId, allowanceCredits))) {
    return { ok: false, reason: 'no_such_member' };
  }
  await recordGroupAudit({
    groupId,
    actorUserId,
    subjectUserId: targetUserId,
    action: 'member_allowance_changed',
    metadata: { allowanceCredits },
  });
  return { ok: true, value: { userId: targetUserId, allowanceCredits } };
}

/**
 * Set or withdraw the caller's own automatic top-up. **Only ever their own**:
 * it is a standing instruction to move their money, so nobody else, an admin
 * included, can give it on their behalf (§23.14 q7). Not audited: it is a
 * person's choice about their own money, not an administrative action on
 * somebody else.
 */
export async function setOwnAutoTopUp(
  actorUserId: string,
  groupId: string,
  autoTopUpMonthlyCredits: number | null
): Promise<BudgetResult<{ autoTopUpMonthlyCredits: number | null }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!(await updateMemberAutoTopUp(groupId, actorUserId, autoTopUpMonthlyCredits))) {
    return { ok: false, reason: 'not_a_member' };
  }
  return { ok: true, value: { autoTopUpMonthlyCredits } };
}

/**
 * Move credits from the caller's own balance into **their own balance in the
 * group**, the money they spend under a filled allowance or an equal split and
 * pay seats from. Any joined member may, viewers included (a viewer pays for
 * their seat). The money stays theirs and comes back when they leave.
 */
export async function topUpOwnGroupBalance(
  actorUserId: string,
  groupId: string,
  credits: number
): Promise<BudgetResult<{ memberBalanceCredits: number }>> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };

  await ensureResparkableSpace(actorUserId);
  const personal = spaceScope(actorUserId);
  await ensureCreditAccount(personal);

  const moved = await transferCreditsToMemberBalance(
    personal,
    resolved.scope,
    groupId,
    credits,
    `Top-up to my balance in ${resolved.membership.group.name}`.slice(0, 500)
  );
  if (!moved) return { ok: false, reason: 'insufficient_personal_credits' };

  logger.info('Resparkable group member balance topped up', { groupId, credits });
  return { ok: true, value: { memberBalanceCredits: round(moved.memberBalanceCredits) } };
}

/**
 * The operational payer is no longer an admin of the group (they left, were
 * removed or were demoted): operational costs fall back to the pool, the change
 * is in the audit log, and the admins are told (§23.14 q10). A no-op for
 * anybody who is not the payer, so every departure path can call it.
 *
 * Never throws: the departure it follows has already happened. Erasure does not
 * call it, because it runs inside `eraseUser`'s transaction where no email can
 * go; the payer column's `SetNull` and `planForRun`'s "a payer who is not a
 * joined admin reads as the pool" cover that path.
 */
export async function releasePayerAndTell(groupId: string, userId: string): Promise<boolean> {
  try {
    if (!(await releaseOperationalPayer(groupId, userId))) return false;
    await recordGroupAudit({
      groupId,
      actorUserId: null,
      subjectUserId: userId,
      action: 'payer_released',
    });

    const admins = await listMemberContacts(groupId, { roles: ['admin'] });
    const group = await findGroupById(groupId);
    if (!group) return true;
    const pool = await findCreditAccount(spaceScope(group.spaceId));
    const groupUrl = `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.group(group.id)}`;
    for (const admin of admins) {
      await sendEmail({
        to: admin.email,
        subject: groupBudgetAlertSubject('payer_gone', group.name),
        react: GroupBudgetAlertEmail({
          kind: 'payer_gone',
          groupName: group.name,
          balanceCredits: round(Math.max(0, pool?.balanceCredits ?? 0)),
          figureCredits: 0,
          groupUrl,
        }),
      }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    logger.warn('Resparkable group payer release failed', {
      groupId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Tell a group's admins when a debit crosses one of their alerts.
 *
 * Called after every spend in a group space. Two alerts, both off until an
 * admin sets them:
 *
 *   - **Low balance**: fires on the crossing, when the balance was above the
 *     mark before this debit and is at or below it after. Crossing rather than
 *     "below" is what stops it emailing on every run while the group is low,
 *     and it is why no "already told them" column exists: a top-up back above
 *     the mark re-arms it by construction.
 *   - **Large run**: one debit costing more than the set share of what was left
 *     before it. Not sent once the balance was already at or below the
 *     low-balance mark, and at most once in 24 hours per group.
 *
 * Never throws. An alert that failed to send must not fail the billing write
 * it follows, which has already happened.
 */
export async function notifyGroupBudgetThresholds(
  scope: SpaceScope,
  balance: { before: number; after: number },
  now: Date = new Date()
): Promise<{ sent: GroupBudgetAlertKind[] }> {
  const sent: GroupBudgetAlertKind[] = [];
  try {
    if (scope.role === 'owner') return { sent };
    const group = await findGroupBySpaceId(scope.spaceId);
    if (!group) return { sent };

    const cost = balance.before - balance.after;
    if (cost <= 0) return { sent };

    const alerts: Array<{ kind: GroupBudgetAlertKind; figure: number }> = [];
    // `before` is rebuilt as after minus the debit, so floating point can put a
    // balance that sat exactly on the mark a hair above it. Compared with a
    // tolerance, so a crossing is a real one.
    const mark = group.lowBalanceAlertCredits;
    if (mark !== null && balance.before > mark + CREDIT_EPSILON && balance.after <= mark) {
      alerts.push({ kind: 'low_balance', figure: mark });
    }
    // Not once the balance was already at or below the low-balance mark: at a
    // low balance nearly every run is "large", and the low-balance alert has
    // told the admins already.
    const percent = group.largeRunAlertPercent;
    const alreadyLow = mark !== null && balance.before <= mark + CREDIT_EPSILON;
    const largeRun =
      percent !== null &&
      !alreadyLow &&
      balance.before > 0 &&
      cost > (balance.before * percent) / 100;
    if (alerts.length === 0 && !largeRun) return { sent };

    const admins = await listMemberContacts(group.id, { roles: ['admin'] });
    if (admins.length === 0) return { sent };

    // At most once in 24 hours, claimed only once there is somebody to tell,
    // and given back below if no email went out, so a failed send does not use
    // up the day's alert.
    if (largeRun && (await claimLargeRunAlert(group.id, now, LARGE_RUN_ALERT_WINDOW_MS))) {
      alerts.push({ kind: 'large_run', figure: round(cost) });
    }

    const groupUrl = `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.group(group.id)}`;

    for (const alert of alerts) {
      let delivered = 0;
      for (const admin of admins) {
        const result = await sendEmail({
          to: admin.email,
          subject: groupBudgetAlertSubject(alert.kind, group.name),
          react: GroupBudgetAlertEmail({
            kind: alert.kind,
            groupName: group.name,
            balanceCredits: round(Math.max(0, balance.after)),
            figureCredits: alert.figure,
            groupUrl,
          }),
        }).catch(() => ({ success: false }));
        if (result.success) {
          delivered += 1;
        } else {
          logger.warn('Resparkable group budget alert not sent', {
            groupId: group.id,
            kind: alert.kind,
          });
        }
      }
      if (delivered > 0) {
        sent.push(alert.kind);
      } else if (alert.kind === 'large_run') {
        await releaseLargeRunAlert(group.id, now);
      }
    }
  } catch (error) {
    logger.warn('Resparkable group budget alert failed', {
      spaceId: scope.spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { sent };
}
