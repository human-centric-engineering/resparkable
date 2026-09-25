/**
 * Billing service: the pre-flight balance check and the spend-recording
 * logic shared by all three attribution sites (chat, ideate, scheduled
 * workflows). See `.context/framework/resparkable/phase-29-plan.md`.
 */

import { after } from 'next/server';

import {
  applyLedgerEntryWithBalance,
  ensureCreditAccount,
  findCreditAccount,
  sumMemberSpendSince,
  type LedgerEntryInput,
} from '@/lib/framework/resparkable/repo/billing';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import {
  DAILY_CAP_WINDOW_MS,
  notifyGroupBudgetThresholds,
} from '@/lib/framework/resparkable/services/group-budget';
import { findResparkableBillingSettings } from '@/lib/framework/resparkable/repo/billing-settings';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { resolveBillingSettings } from '@/lib/framework/resparkable/settings';
import { APIError, ForbiddenError, InsufficientCreditsError } from '@/lib/api/errors';
import type { ResparkableCreditLedgerEntry } from '@prisma/client';

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
 * Refuse a billing-gated action before any provider call is made.
 *
 * Three refusals, in the order a person would want to hear them (§23.12):
 *
 *   1. **A viewer spends nothing.** Zero, not a small cap. A viewer has no write
 *      capability bound, and every billed action in the tier is a write or
 *      produces one. This also covers a grantee's viewer scope on somebody
 *      else's personal space, which must never debit its owner.
 *   2. **The space's balance, and only the space's.** Exactly one account is
 *      resolved, and it is the scope's. A group space's empty balance is a
 *      refusal, **never** a redirect to the member's personal balance: that
 *      fallback is the one that ends with a member discovering they paid for the
 *      group out of credits they bought for their own brain.
 *   3. **A group member's daily cap**, when an admin has set one. The blast
 *      radius for "any member can spend everyone's credits", enforced here so a
 *      looping workflow is refused before its next provider call, not debited
 *      after it.
 *
 * Lazily backfills a credit account for a pre-phase-29 space (zero balance,
 * no retroactive `newUserGrantCredits`: that grant is for genuinely new
 * users, minted in `ensureResparkableSpace`'s create branch).
 */
export async function assertCanSpend(scope: SpaceScope): Promise<void> {
  if (scope.role === 'viewer') {
    throw new ForbiddenError('Viewers cannot use features that spend credits');
  }

  const account = await ensureCreditAccount(scope);
  if (account.balanceCredits <= 0) {
    throw new InsufficientCreditsError(
      scope.role === 'owner'
        ? undefined
        : "This group's credit balance is empty. A group admin can top it up."
    );
  }

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
}

/**
 * Cheap, non-throwing balance check for the queue's skip gate, where there is
 * no member to cap and no role to refuse: the run is the space's own.
 */
export async function hasPositiveBalance(scope: SpaceScope): Promise<boolean> {
  const account = await findCreditAccount(scope);
  return (account?.balanceCredits ?? 0) > 0;
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

/**
 * Debit an agent-spend ledger entry for real, already-incurred cost.
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
): Promise<ResparkableCreditLedgerEntry | null> {
  // `!Number.isFinite`, not just `<= 0`: `NaN <= 0` is false, so a NaN cost
  // (an unmapped model in the provider's cost table, say) would otherwise
  // fall through into the ledger math and corrupt `balanceCredits` via a
  // `NaN` increment — silently breaking every future balance check for the
  // account, not just this one write.
  if (!Number.isFinite(input.tokenCostUsd) || input.tokenCostUsd <= 0) return null;

  const settings = resolveBillingSettings(await findResparkableBillingSettings());
  const serviceChargeUsd = input.tokenCostUsd * (settings.serviceChargePercent / 100);
  const totalUsd = input.tokenCostUsd + serviceChargeUsd;
  const creditsDelta = -(totalUsd * settings.creditsPerUsd);

  const entry: LedgerEntryInput = {
    kind: 'agent_spend',
    creditsDelta,
    tokenCostUsd: input.tokenCostUsd,
    serviceChargeUsd,
    totalUsd,
    ...(input.relatedConversationId ? { relatedConversationId: input.relatedConversationId } : {}),
    ...(input.relatedWorkflowExecutionId
      ? { relatedWorkflowExecutionId: input.relatedWorkflowExecutionId }
      : {}),
    ...(input.relatedCostLogId ? { relatedCostLogId: input.relatedCostLogId } : {}),
  };

  await ensureCreditAccount(scope);
  const { entry: written, balanceAfter } = await applyLedgerEntryWithBalance(scope, {
    ...entry,
    ...(input.authorUserId !== undefined ? { authorUserId: input.authorUserId } : {}),
  });

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
        before: balanceAfter - creditsDelta,
        after: balanceAfter,
      });
    if (input.awaitAlerts) await alert();
    else scheduleAfterResponse(alert);
  }

  return written;
}
