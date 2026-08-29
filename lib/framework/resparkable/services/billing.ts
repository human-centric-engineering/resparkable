/**
 * Billing service: the pre-flight balance check and the spend-recording
 * logic shared by all three attribution sites (chat, ideate, scheduled
 * workflows). See `.context/framework/resparkable/phase-29-plan.md`.
 */

import {
  applyLedgerEntry,
  ensureCreditAccount,
  findCreditAccount,
  type LedgerEntryInput,
} from '@/lib/framework/resparkable/repo/billing';
import { findResparkableBillingSettings } from '@/lib/framework/resparkable/repo/billing-settings';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { resolveBillingSettings } from '@/lib/framework/resparkable/settings';
import { InsufficientCreditsError } from '@/lib/api/errors';
import type { ResparkableCreditLedgerEntry } from '@prisma/client';

/**
 * Refuse a billing-gated action before any provider call is made.
 *
 * Lazily backfills a credit account for a pre-phase-29 space (zero balance,
 * no retroactive `newUserGrantCredits` (that grant is for genuinely new
 * users, minted in `ensureResparkableSpace`'s create branch).
 */
export async function assertPositiveBalance(scope: SpaceScope): Promise<void> {
  const account = await ensureCreditAccount(scope);
  if (account.balanceCredits <= 0) {
    throw new InsufficientCreditsError();
  }
}

/** Cheap, non-throwing variant for the Site B tick job's queue-skip check. */
export async function hasPositiveBalance(scope: SpaceScope): Promise<boolean> {
  const account = await findCreditAccount(scope);
  return (account?.balanceCredits ?? 0) > 0;
}

export interface RecordAgentSpendInput {
  tokenCostUsd: number;
  relatedConversationId?: string;
  relatedWorkflowExecutionId?: string;
  relatedCostLogId?: string;
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
  return applyLedgerEntry(scope, entry);
}
