/**
 * Billing repo: owner-scoped reads/writes over `ResparkableCreditAccount` and
 * `ResparkableCreditLedgerEntry`, plus a small set of admin cross-user
 * functions for the allocation UI.
 *
 * The admin functions are the one deliberate exception to D5's "every repo
 * function takes an `OwnerScope`" rule in this file. Admin billing management
 * is inherently cross-user by nature, the same reasoning `lib/privacy/erase-user.ts`
 * and the admin user-management routes already rely on, gated by `withAdminAuth`
 * at the route rather than by the repo signature. They are named and grouped
 * separately below so that exception stays visible rather than blending in.
 */

import { prisma } from '@/lib/db/client';
import {
  ownerScope,
  ownerWhere,
  type OwnerScope,
} from '@/lib/framework/resparkable/repo/owner-scope';
import { isUniqueConstraintViolation } from '@/lib/framework/resparkable/repo/shared';
import { logger } from '@/lib/logging';
import type { ResparkableCreditAccount, ResparkableCreditLedgerEntry } from '@prisma/client';

/** The ledger's `kind` discriminator; see the schema doc comment. */
export type CreditLedgerEntryKind = 'admin_grant' | 'agent_spend' | 'refund';

export interface LedgerEntryInput {
  kind: CreditLedgerEntryKind;
  creditsDelta: number;
  tokenCostUsd?: number;
  serviceChargeUsd?: number;
  totalUsd?: number;
  relatedConversationId?: string;
  relatedWorkflowExecutionId?: string;
  relatedCostLogId?: string;
  note?: string;
  createdByAdminId?: string;
}

/**
 * Read the caller's credit account, or `null` when none exists yet.
 */
export async function findCreditAccount(
  scope: OwnerScope
): Promise<ResparkableCreditAccount | null> {
  return prisma.resparkableCreditAccount.findUnique({ where: { userId: scope.userId } });
}

/**
 * Get the caller's credit account, creating it on first use.
 *
 * Idempotent and safe under concurrency, mirroring `ensureResparkableSpace`
 * (`services/space.ts`): two parallel first-touches race on `userId @unique`,
 * the loser catches the constraint violation and re-reads.
 */
export async function ensureCreditAccount(
  scope: OwnerScope,
  initialBalance = 0
): Promise<ResparkableCreditAccount> {
  const existing = await findCreditAccount(scope);
  if (existing) return existing;

  try {
    return await prisma.resparkableCreditAccount.create({
      data: { userId: scope.userId, balanceCredits: initialBalance },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const raced = await findCreditAccount(scope);
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Adjust the balance and append the ledger row atomically: a partial write
 * (balance moved but no ledger row, or the reverse) must never be observable.
 *
 * `entry.creditsDelta` and the balance adjustment must agree; callers pass one
 * number and this applies it to both, so they cannot drift apart.
 *
 * Throws the transaction's raw error on conflict, in particular Prisma's
 * `P2002` when `entry.kind`/`entry.relatedWorkflowExecutionId` collide with an
 * existing row (the idempotency guard the schema documents). Callers that can
 * hit that guard (the Site B tick job) catch it there; callers that can't
 * (chat, ideate: they never pass `relatedWorkflowExecutionId`) don't need to.
 */
export async function applyLedgerEntry(
  scope: OwnerScope,
  entry: LedgerEntryInput
): Promise<ResparkableCreditLedgerEntry> {
  return prisma.$transaction(async (tx) => {
    await tx.resparkableCreditAccount.update({
      where: { userId: scope.userId },
      data: { balanceCredits: { increment: entry.creditsDelta } },
    });
    return tx.resparkableCreditLedgerEntry.create({
      data: { ...entry, ...ownerWhere(scope) },
    });
  });
}

// ─── Site B: scheduled/queued workflow executions ──────────────────────────
//
// `AiWorkflowExecution` is a platform table, not one of this tier's own, but
// `jobs.ts` cannot reach `prisma` directly (the framework-tier ESLint
// boundary confines the client to `repo/**`), so the tick job's query lives
// here rather than bypassing that boundary. Cross-tier FKs already exist
// elsewhere in this schema (`ResparkableReview.workflowExecutionId`); reading
// across the same boundary is no new precedent.

export interface BillableWorkflowExecution {
  id: string;
  userId: string | null;
  scope: unknown;
  totalCostUsd: number;
}

/**
 * Recently terminal, resparkable-slug workflow executions: candidates for
 * the Site B billing pass.
 *
 * Ordered newest-first rather than by the oldest-swept-first cursor the rest
 * of this tier uses (`listSpacesDueSweep`): there is no cursor column to
 * stamp on a platform-owned table, and newest-first is self-correcting
 * without one. A fresh completion is always in the top `limit` rows, so it is
 * billed within one tick regardless of how much already-billed history
 * exists; a repeat `P2002` on an already-billed row is cheap and ages out of
 * the window on its own as newer completions push it down. Oldest-first would
 * risk exactly the stuck-cursor bug this file's own doc comments warn about:
 * the same `limit` oldest rows re-selected forever once billed history
 * exceeds it.
 */
export async function findRecentTerminalResparkableExecutions(
  workflowSlugs: string[],
  terminalStatuses: string[],
  limit: number
): Promise<BillableWorkflowExecution[]> {
  return prisma.aiWorkflowExecution.findMany({
    where: {
      status: { in: terminalStatuses },
      workflow: { slug: { in: workflowSlugs } },
    },
    select: { id: true, userId: true, scope: true, totalCostUsd: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

// ─── Admin cross-user functions ────────────────────────────────────────────
// See the file-level doc comment: intentionally not OwnerScope-shaped.

export interface AdminCreditAccountRow {
  userId: string;
  balanceCredits: number;
  userName: string | null;
  userEmail: string;
}

/**
 * The per-user balance table the admin Billing tab renders.
 *
 * Two queries merged in JS rather than a Prisma `include`, because there is no
 * relation to join through: `ResparkableCreditAccount.userId` references
 * `ResparkableSpace.userId`, not `User.id` directly, and `User` is a
 * Sunrise-owned model this tier must never add a relation field to
 * (CLAUDE.md). A user who has never touched a billing-aware code path (no
 * account row yet) still appears, at a balance of 0: an admin granting
 * credits to a brand-new user is the common case, not an edge case.
 */
export async function listCreditAccountsForAdmin(
  options: {
    cursor?: string;
    limit?: number;
  } = {}
): Promise<AdminCreditAccountRow[]> {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true },
    orderBy: { email: 'asc' },
    take: options.limit ?? 50,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
  if (users.length === 0) return [];

  const accounts = await prisma.resparkableCreditAccount.findMany({
    where: { userId: { in: users.map((user) => user.id) } },
    select: { userId: true, balanceCredits: true },
  });
  const balanceByUserId = new Map(
    accounts.map((account) => [account.userId, account.balanceCredits])
  );

  return users.map((user) => ({
    userId: user.id,
    balanceCredits: balanceByUserId.get(user.id) ?? 0,
    userName: user.name,
    userEmail: user.email,
  }));
}

/**
 * An admin grants credits to a user, creating their account first if needed.
 * Writes an `admin_grant` ledger row.
 */
export async function grantCreditsAsAdmin(
  userId: string,
  amount: number,
  note: string | undefined,
  adminId: string
): Promise<ResparkableCreditLedgerEntry> {
  // `ownerScope()` is normally reserved for a *verified session's own*
  // identity (see its doc comment); the admin grant is the one legitimate
  // exception, minting a scope for a target user id that came from an
  // admin-only, Zod-validated request body rather than the caller's own
  // session. That is exactly why this call is confined to this
  // admin-only function rather than exposed as a general helper.
  const scope = ownerScope(userId);
  await ensureCreditAccount(scope);

  logger.info('Resparkable admin credit grant', { userId, amount, adminId });

  return applyLedgerEntry(scope, {
    kind: 'admin_grant',
    creditsDelta: amount,
    ...(note !== undefined ? { note } : {}),
    createdByAdminId: adminId,
  });
}
