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
  | 'insufficient_personal_credits';

export type BudgetResult<T> = { ok: true; value: T } | { ok: false; reason: BudgetRefusal };

export interface GroupBudgetView {
  balanceCredits: number;
  fundingMode: FundingMode;
  /** Whether the caller may top the group up under its funding mode. */
  canTopUp: boolean;
  /** The caller's own personal balance, which is what a top-up comes out of. */
  yourPersonalBalanceCredits: number;
  /** The caller's cap in this group, and what they have spent against it today. */
  you: { dailyCreditCap: number | null; spentLastDayCredits: number };
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

  return {
    ok: true,
    value: {
      balanceCredits: round(account?.balanceCredits ?? 0),
      fundingMode,
      canTopUp: mayTopUp(scope.role, fundingMode),
      yourPersonalBalanceCredits: round(personal?.balanceCredits ?? 0),
      you: { dailyCreditCap: membership.dailyCreditCap, spentLastDayCredits: round(spentLastDay) },
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
  return { ok: true, value: { balanceCredits: round(moved.groupBalanceCredits) } };
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
