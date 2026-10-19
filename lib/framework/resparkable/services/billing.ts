/**
 * Billing service: the pre-flight balance check and the spend-recording
 * logic shared by all three attribution sites (chat, ideate, scheduled
 * workflows). See `.context/framework/resparkable/phase-29-plan.md`.
 */

import { after } from 'next/server';

import {
  applyLedgerEntryWithBalance,
  ensureCreditAccount,
  sumMemberSpendSince,
  type LedgerEntryInput,
} from '@/lib/framework/resparkable/repo/billing';
import {
  debitEqualSplit,
  debitMemberBalance,
  debitPoolWithinAllowance,
  findGroupWithClockBySpaceId,
  findJoinedMembership,
  type SpendDetail,
} from '@/lib/framework/resparkable/repo/group-billing';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import {
  canAffordOperational,
  planForRun,
  resolveCharge,
  topUpAutomatically,
  type ChargePlan,
} from '@/lib/framework/resparkable/services/group-billing';
import {
  DAILY_CAP_WINDOW_MS,
  notifyGroupBudgetThresholds,
} from '@/lib/framework/resparkable/services/group-budget';
import { findResparkableBillingSettings } from '@/lib/framework/resparkable/repo/billing-settings';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { resolveBillingSettings } from '@/lib/framework/resparkable/settings';
import { APIError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';

/**
 * A member has spent their `dailyCreditCap` from the group's balance.
 *
 * A 402 like an empty balance, but its own code: the UI says "you have reached
 * your daily limit in this group", which is a different sentence from "the
 * group is out of credits", and a member told the second when the first is
 * true goes and asks an admin to top up a balance that is not empty.
 */
export class DailyCreditCapError extends APIError {
  constructor() {
    super(
      'You have reached your daily credit limit in this group. It resets over the next 24 hours.',
      'DAILY_CREDIT_CAP_REACHED',
      402
    );
    this.name = 'DailyCreditCapError';
  }
}

/**
 * Refuse a billing-gated action before any provider call is made, and say who
 * will pay for it.
 *
 * The refusals, in the order a person would want to hear them (§23.12):
 *
 *   1. **A viewer spends nothing.** Zero, not a small cap. A viewer has no write
 *      capability bound, and every billed action in the tier is a write or
 *      produces one. This also covers a grantee's viewer scope on somebody
 *      else's personal space, which must never debit its owner.
 *   2. **Whoever the group's settings name, and only them** (phase 62,
 *      `services/group-billing.ts`). Exactly one source is chosen, before the
 *      run, and an empty one is a refusal: **never** a redirect to the member's
 *      personal balance, and never a switch to a different group account.
 *   3. **A group member's daily cap**, when an admin has set one. The blast
 *      radius for "any member can spend everyone's credits", enforced here so a
 *      looping workflow is refused before its next provider call, not debited
 *      after it.
 *
 * Returns the {@link ChargePlan} the debit afterwards must be given, so a run is
 * billed to the source it was cleared against.
 *
 * Lazily backfills a credit account for a pre-phase-29 space (zero balance,
 * no retroactive `newUserGrantCredits`: that grant is for genuinely new
 * users, minted in `ensureResparkableSpace`'s create branch).
 */
export async function assertCanSpend(scope: SpaceScope): Promise<ChargePlan> {
  const plan = await resolveCharge(scope);

  // `admin | member` are the group roles that reach here; `owner` is a personal
  // space, where the balance is the only cap there is.
  if (scope.role !== 'owner' && scope.actorUserId) {
    const membership = await findMembershipBySpace(scope.actorUserId, scope.spaceId);
    const cap = membership?.dailyCreditCap ?? null;
    if (cap !== null) {
      const since = new Date(Date.now() - DAILY_CAP_WINDOW_MS);
      const spent = await sumMemberSpendSince(scope, scope.actorUserId, since);
      if (spent >= cap) throw new DailyCreditCapError();
    }
  }
  return plan;
}

/**
 * Cheap, non-throwing check for the queue's skip gate, where there is no member
 * to cap and no role to refuse: the run is the space's own. In a group it asks
 * whoever pays the group's operational costs (phase 62).
 */
export async function hasPositiveBalance(scope: SpaceScope): Promise<boolean> {
  return canAffordOperational(scope);
}

export interface RecordAgentSpendInput {
  tokenCostUsd: number;
  relatedConversationId?: string;
  relatedWorkflowExecutionId?: string;
  relatedCostLogId?: string;
  /**
   * Who started the run, for the billing pass (see `LedgerEntryInput`). Live
   * request paths leave it out and the scope's actor is recorded.
   */
  authorUserId?: string | null;
  /**
   * Who pays, as {@link assertCanSpend} decided before the run. Left out by the
   * billing pass, which re-derives it from the run's author (`planForRun`).
   */
  plan?: ChargePlan;
  /**
   * Wait for a group's budget alerts before returning. The billing pass sets
   * it: nobody is waiting on a tick, and awaiting keeps one pass from starting
   * a hundred alert chains at once. Request paths leave it out, and the alert
   * runs after the response instead (see {@link scheduleAfterResponse}).
   */
  awaitAlerts?: boolean;
}

/**
 * Run a task after the current response has been sent, and keep the host from
 * dropping it: Next's `after()` extends the request's lifetime on platforms that
 * would otherwise freeze or end the work once the response is out. Outside a
 * request (the queue tick, a script) `after()` throws, and the task simply runs
 * in the background of a long-lived process.
 */
function scheduleAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** What a debit charged, for the caller's count. */
export interface RecordedSpend {
  credits: number;
  source: ChargePlan['source'];
}

/**
 * Debit real, already-incurred cost to whoever the plan names.
 *
 * Computes the service charge from `ResparkableBillingSettings` and converts
 * to credits via `creditsPerUsd`. The debit always reflects real usage
 * (`tokenCostUsd`), never the estimate that gated the pre-flight check
 * (§16.6 risk 20a in the plan doc).
 *
 * Zero-cost calls (nothing actually billed, e.g. ideate's no-connections
 * early return) are skipped rather than writing a zero-delta ledger row.
 */
export async function recordAgentSpend(
  scope: SpaceScope,
  input: RecordAgentSpendInput
): Promise<RecordedSpend | null> {
  // `!Number.isFinite`, not just `<= 0`: `NaN <= 0` is false, so a NaN cost
  // (an unmapped model in the provider's cost table, say) would otherwise
  // fall through into the ledger math and corrupt `balanceCredits` via a
  // `NaN` increment — silently breaking every future balance check for the
  // account, not just this one write.
  if (!Number.isFinite(input.tokenCostUsd) || input.tokenCostUsd <= 0) return null;

  const settings = resolveBillingSettings(await findResparkableBillingSettings());
  const serviceChargeUsd = input.tokenCostUsd * (settings.serviceChargePercent / 100);
  const totalUsd = input.tokenCostUsd + serviceChargeUsd;
  const credits = totalUsd * settings.creditsPerUsd;

  const detail: SpendDetail = {
    tokenCostUsd: input.tokenCostUsd,
    serviceChargeUsd,
    totalUsd,
    ...(input.relatedConversationId ? { relatedConversationId: input.relatedConversationId } : {}),
    ...(input.relatedWorkflowExecutionId
      ? { relatedWorkflowExecutionId: input.relatedWorkflowExecutionId }
      : {}),
    ...(input.relatedCostLogId ? { relatedCostLogId: input.relatedCostLogId } : {}),
  };
  const author = input.authorUserId !== undefined ? input.authorUserId : scope.actorUserId;
  const plan = input.plan ?? (await planForRun(scope, author));

  if (plan.source === 'member') {
    const debited = await debitMemberBalance(
      scope,
      plan.groupId,
      plan.memberUserId,
      credits,
      detail,
      author
    );
    if (debited) {
      if (debited.balanceAfter < 0) await topUpMembers(scope, [plan.memberUserId]);
      return { credits, source: 'member' };
    }
    // The member left between the pre-flight and the debit. The run happened,
    // so the pool pays rather than nobody (phase-62-plan.md, known edges).
  }

  if (plan.source === 'split') {
    const shares = await debitEqualSplit(scope, plan.groupId, plan.roles, credits, detail, author);
    if (shares.length > 0) {
      const short = shares.filter((share) => share.balanceAfter < 0).map((share) => share.userId);
      if (short.length > 0) await topUpMembers(scope, short);
      return { credits, source: 'split' };
    }
  }

  let balanceAfter: number;
  if (plan.source === 'allowance' && author) {
    ({ poolBalanceAfter: balanceAfter } = await debitPoolWithinAllowance(
      scope,
      plan.groupId,
      author,
      credits,
      detail
    ));
  } else {
    await ensureCreditAccount(scope);
    const entry: LedgerEntryInput = {
      kind: 'agent_spend',
      creditsDelta: -credits,
      ...detail,
      ...(input.authorUserId !== undefined ? { authorUserId: input.authorUserId } : {}),
    };
    ({ balanceAfter } = await applyLedgerEntryWithBalance(scope, entry));
  }

  // A group's two admin-only alerts (§23.12). After the write, never before it:
  // the debit is real cost already incurred, and an alert is news about it. The
  // balance is the one the debit's own UPDATE returned, so two concurrent debits
  // each see their own step and a crossing is reported once.
  //
  // Not awaited on a request path: the chat stream awaits this function before
  // its "done" event, and a member should not wait on one email per admin. It
  // never rejects.
  if (scope.role !== 'owner') {
    const alert = () =>
      notifyGroupBudgetThresholds(scope, {
        before: balanceAfter + credits,
        after: balanceAfter,
      });
    if (input.awaitAlerts) await alert();
    else scheduleAfterResponse(alert);
  }

  return { credits, source: plan.source === 'allowance' ? 'allowance' : 'space' };
}

/**
 * After a debit left members below zero, run each one's agreed automatic
 * top-up. Best effort: a balance left below zero is a debt, which the shortfall
 * policy already handles.
 */
async function topUpMembers(scope: SpaceScope, memberUserIds: string[]): Promise<void> {
  try {
    const group = await findGroupWithClockBySpaceId(scope.spaceId);
    if (!group) return;
    for (const userId of memberUserIds) {
      const membership = await findJoinedMembership(group.id, userId);
      if (membership?.autoTopUpMonthlyCredits) {
        await topUpAutomatically(scope, group, membership, 'member');
      }
    }
  } catch (error) {
    logger.warn('Resparkable group top-up after debit failed', {
      spaceId: scope.spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
