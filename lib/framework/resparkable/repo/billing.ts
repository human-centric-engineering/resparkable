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
import { Prisma } from '@prisma/client';
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
 * Terminal, resparkable-slug workflow executions that have **not yet been
 * billed** — the candidates for the Site B billing pass.
 *
 * ## The cursor this replaces, and why it lost rows
 *
 * This used to be `orderBy: { updatedAt: 'desc' }, take: 100`, on the argument
 * that newest-first is self-correcting without a cursor column: a fresh
 * completion is always in the top 100 rows, so it is billed within one tick
 * however much billed history exists. That reasoning holds for one completion
 * at a time and fails in exactly the case that matters. If more than `limit`
 * executions reach a terminal state between two passes — a hundred and fifty
 * nightly triages finishing inside one window, which is a hundred and fifty
 * users, not a hundred and fifty thousand — the oldest of them fall off the
 * bottom of the window and are **never billed at all**. Nothing errors. The
 * platform simply eats the cost of the runs it lost, silently, and the effect
 * grows with the install.
 *
 * Anti-joining against the ledger fixes it at the root: an execution leaves the
 * candidate set the moment it is billed, permanently, so the set only ever
 * shrinks. That is what makes oldest-first safe here where it would not be
 * against a plain `take` — the stuck-cursor bug this file's doc comments warn
 * about needs a *stable* set of un-consumed rows at the head of the ordering,
 * and there is no longer one. Oldest-first is then the right way round, because
 * a run that has waited longest to be billed should be billed first.
 *
 * The `limit` survives as a per-pass bound rather than as a window: rows it does
 * not reach stay candidates and are picked up on the next drain.
 *
 * `totalCostUsd > 0` is part of the same argument rather than an optimisation.
 * A zero-cost run can never produce a ledger entry — `recordAgentSpend` returns
 * `null` below its own threshold — so leaving those rows in the candidate set
 * would mean every pass re-fetched the same permanently-unbillable executions
 * and the set would stop draining, which is the very failure the anti-join is
 * here to remove.
 *
 * `ResparkableCreditLedgerEntry`'s `@@unique([kind, relatedWorkflowExecutionId])`
 * is what the `NOT EXISTS` reads, and it stays the last line of defence — two
 * workers racing the same execution still collide there rather than
 * double-charging.
 */
export async function findUnbilledTerminalResparkableExecutions(
  workflowSlugs: string[],
  terminalStatuses: string[],
  limit: number
): Promise<BillableWorkflowExecution[]> {
  if (workflowSlugs.length === 0 || terminalStatuses.length === 0) return [];

  // Raw SQL, and not by preference. `relatedWorkflowExecutionId` is a **soft**
  // reference with no FK — the tier-boundary pattern this schema uses
  // everywhere it points at a platform-owned row — so there is no Prisma
  // relation to express `NOT EXISTS` through. Two round trips would work and
  // would reintroduce the window: whatever the first query fetches is the set
  // the second can filter, so anything past `limit` is still lost.
  //
  // The anti-join goes straight down `@@unique([kind, relatedWorkflowExecutionId])`
  // — `kind` is the leading column and it is a constant here — so it costs one
  // index probe per candidate.
  return prisma.$queryRaw<BillableWorkflowExecution[]>`
    SELECT e."id", e."userId", e."scope", e."totalCostUsd"
    FROM "ai_workflow_execution" e
    JOIN "ai_workflow" w ON w."id" = e."workflowId"
    WHERE e."status" IN (${Prisma.join(terminalStatuses)})
      AND w."slug" IN (${Prisma.join(workflowSlugs)})
      AND e."totalCostUsd" > 0
      AND NOT EXISTS (
        SELECT 1 FROM "framework_resparkable_credit_ledger_entry" l
        WHERE l."kind" = 'agent_spend'
          AND l."relatedWorkflowExecutionId" = e."id"
      )
    ORDER BY e."updatedAt" ASC
    LIMIT ${limit}
  `;
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
