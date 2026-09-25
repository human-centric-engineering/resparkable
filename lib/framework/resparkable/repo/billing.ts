/**
 * Billing repo: owner-scoped reads/writes over `ResparkableCreditAccount` and
 * `ResparkableCreditLedgerEntry`, plus a small set of admin cross-user
 * functions for the allocation UI.
 *
 * The admin functions are the one deliberate exception to D5's "every repo
 * function takes an `SpaceScope`" rule in this file. Admin billing management
 * is inherently cross-user by nature, the same reasoning `lib/privacy/erase-user.ts`
 * and the admin user-management routes already rely on, gated by `withAdminAuth`
 * at the route rather than by the repo signature. They are named and grouped
 * separately below so that exception stays visible rather than blending in.
 */

import { prisma } from '@/lib/db/client';
import {
  authoredBy,
  spaceScope,
  spaceWhere,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import {
  RESPARKABLE_SCHEDULE_OWNER_KEY,
  RESPARKABLE_SCHEDULE_SPACE_KEY,
} from '@/lib/framework/resparkable/repo/space-scope';
import { isUniqueConstraintViolation } from '@/lib/framework/resparkable/repo/shared';
import { logger } from '@/lib/logging';
import { Prisma } from '@prisma/client';
import type { ResparkableCreditAccount, ResparkableCreditLedgerEntry } from '@prisma/client';

/** The ledger's `kind` discriminator; see the schema doc comment. */
export type CreditLedgerEntryKind =
  | 'admin_grant'
  | 'agent_spend'
  | 'refund'
  /** A group top-up, the giver's side (phase 50). */
  | 'transfer_out'
  /** A group top-up, the group's side. */
  | 'transfer_in';

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
  /**
   * Who the row is attributed to, when that is not the scope's actor (§23.9's
   * `actorUserId`, which is this table's `createdByUserId`). `undefined` means
   * "the scope's actor", and every live request path leaves it so. Two writers
   * set it: the billing pass, which bills a finished run under a background
   * scope while the run was started by a named member, and the grants, which
   * write into somebody's account without that person having acted (`null`).
   */
  authorUserId?: string | null;
}

/**
 * Read the caller's credit account, or `null` when none exists yet.
 */
export async function findCreditAccount(
  scope: SpaceScope
): Promise<ResparkableCreditAccount | null> {
  return prisma.resparkableCreditAccount.findUnique({ where: { spaceId: scope.spaceId } });
}

/**
 * Get the caller's credit account, creating it on first use.
 *
 * Idempotent and safe under concurrency, mirroring `ensureResparkableSpace`
 * (`services/space.ts`): two parallel first-touches race on `userId @unique`,
 * the loser catches the constraint violation and re-reads.
 */
export async function ensureCreditAccount(
  scope: SpaceScope,
  initialBalance = 0
): Promise<ResparkableCreditAccount> {
  const existing = await findCreditAccount(scope);
  if (existing) return existing;

  try {
    return await prisma.resparkableCreditAccount.create({
      data: { spaceId: scope.spaceId, balanceCredits: initialBalance },
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
  scope: SpaceScope,
  entry: LedgerEntryInput
): Promise<ResparkableCreditLedgerEntry> {
  return (await applyLedgerEntryWithBalance(scope, entry)).entry;
}

/**
 * {@link applyLedgerEntry}, also returning the balance the account holds after
 * this row, read from the same `UPDATE`. The group budget alerts need the
 * balance either side of one debit, and reading it anywhere but inside the
 * transaction lets two concurrent debits both see the same "before", so a
 * crossing is reported twice or not at all.
 */
export async function applyLedgerEntryWithBalance(
  scope: SpaceScope,
  entry: LedgerEntryInput
): Promise<{ entry: ResparkableCreditLedgerEntry; balanceAfter: number }> {
  const { authorUserId, ...row } = entry;
  const author = authoredBy(scope);

  return prisma.$transaction(async (tx) => {
    const account = await tx.resparkableCreditAccount.update({
      where: { spaceId: scope.spaceId },
      data: { balanceCredits: { increment: entry.creditsDelta } },
    });
    const written = await tx.resparkableCreditLedgerEntry.create({
      data: {
        ...row,
        // The scope wins, as everywhere: the space is never a caller's value.
        // The author is the scope's actor unless the writer names another (see
        // `authorUserId`).
        ...author,
        createdByUserId: authorUserId === undefined ? author.createdByUserId : authorUserId,
      },
    });
    return { entry: written, balanceAfter: account.balanceCredits };
  });
}

/**
 * Credits one member has spent in a space since `since`: the sum behind a
 * group member's `dailyCreditCap` (§23.12).
 *
 * **The one repo read that names a member, and why it is not an ACL.** D5's rule
 * is that the actor never filters *content*: a group space has no per-row
 * privacy, and a `where` on the actor would build one. This filters no content.
 * It is a pre-flight sum over the space's own ledger, returning one number to
 * the billing service, which answers "has this member reached their cap" and
 * nothing else. The member arrives as an explicit argument rather than being
 * read off the scope, so it cannot be mistaken for the scope's actor filtering
 * a list, and the isolation sweep's enumeration of scoped calls is unaffected.
 *
 * Reads `@@index([spaceId, createdByUserId, createdAt])`.
 */
export async function sumMemberSpendSince(
  scope: SpaceScope,
  memberUserId: string,
  since: Date
): Promise<number> {
  const result = await prisma.resparkableCreditLedgerEntry.aggregate({
    where: {
      ...spaceWhere(scope),
      kind: 'agent_spend',
      createdByUserId: memberUserId,
      createdAt: { gte: since },
    },
    _sum: { creditsDelta: true },
  });
  // Spend rows are negative deltas; the cap is a positive number of credits.
  // Subtracted from zero rather than negated, so an empty sum is 0 and not -0.
  return 0 - (result._sum.creditsDelta ?? 0);
}

/** One member's figures in a group's ledger, for the admin's budget view. */
export interface MemberLedgerSummary {
  userId: string;
  /** Credits spent from the group's balance in the window. Positive. */
  spentCredits: number;
  /** Credits moved into the group's balance in the window. Positive. */
  contributedCredits: number;
}

/**
 * Spend and contributions per member in a space since `since`: the per-person
 * figures §23.12 gives a group **admin** and nobody else.
 *
 * Like {@link sumMemberSpendSince}, this is not an ACL: it filters no content and
 * returns money, not productivity. The service is what keeps it admin-only;
 * members see the balance and nothing about who spent it (23.8). Rows with no
 * author (a run nobody started, a platform grant) are left out, because there is
 * no person to put them against.
 */
export async function summariseLedgerByMemberSince(
  scope: SpaceScope,
  since: Date
): Promise<MemberLedgerSummary[]> {
  const rows = await prisma.resparkableCreditLedgerEntry.groupBy({
    by: ['createdByUserId', 'kind'],
    where: {
      ...spaceWhere(scope),
      kind: { in: ['agent_spend', 'transfer_in'] },
      createdByUserId: { not: null },
      createdAt: { gte: since },
    },
    _sum: { creditsDelta: true },
  });

  const byUser = new Map<string, MemberLedgerSummary>();
  for (const row of rows) {
    if (!row.createdByUserId) continue;
    const entry = byUser.get(row.createdByUserId) ?? {
      userId: row.createdByUserId,
      spentCredits: 0,
      contributedCredits: 0,
    };
    const sum = row._sum.creditsDelta ?? 0;
    if (row.kind === 'agent_spend') entry.spentCredits += 0 - sum;
    else entry.contributedCredits += sum;
    byUser.set(row.createdByUserId, entry);
  }
  return [...byUser.values()];
}

/**
 * Move credits from a person's own balance into a group's (§23.12, amended
 * 2026-09-25). One transaction, two ledger rows, both attributed to the giver.
 *
 * **Refuses rather than overdraws.** The giver's balance is decremented only
 * where it still covers the amount, checked in the same statement, so two
 * top-ups racing each other cannot take a personal balance below zero. `null`
 * means it did not cover it and nothing was written.
 *
 * Two scopes, because this is the one write in the tier that touches two spaces
 * at once: the giver's own (`from`, an `owner` scope from their session) and the
 * group's (`to`, resolved from their membership). The service decides whether
 * the giver may; this only makes the move atomic.
 */
export async function transferCreditsToGroup(
  from: SpaceScope,
  to: SpaceScope,
  credits: number,
  note: string
): Promise<{ groupBalanceCredits: number } | null> {
  if (from.role !== 'owner' || !from.actorUserId) {
    throw new Error('transferCreditsToGroup: the giver must be the owner of their own space');
  }
  const giver = from.actorUserId;

  return prisma.$transaction(async (tx) => {
    const taken = await tx.resparkableCreditAccount.updateMany({
      where: { spaceId: from.spaceId, balanceCredits: { gte: credits } },
      data: { balanceCredits: { decrement: credits } },
    });
    if (taken.count === 0) return null;

    const group = await tx.resparkableCreditAccount.upsert({
      where: { spaceId: to.spaceId },
      create: { spaceId: to.spaceId, balanceCredits: credits },
      update: { balanceCredits: { increment: credits } },
    });

    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: from.spaceId,
        createdByUserId: giver,
        kind: 'transfer_out',
        creditsDelta: -credits,
        note,
      },
    });
    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: to.spaceId,
        createdByUserId: giver,
        kind: 'transfer_in',
        creditsDelta: credits,
      },
    });

    return { groupBalanceCredits: group.balanceCredits };
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
  totalCostUsd: number;
  /**
   * The space the run is billed to and its `ResparkableSpace.kind`, resolved in
   * the query itself. One source for "which space": the `COALESCE` below. The
   * billing pass used to re-derive the space in TypeScript, which had to mirror
   * that precedence exactly and could disagree with it on an odd `scope` value,
   * billing one space with another space's kind.
   */
  spaceId: string;
  spaceKind: string;
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
 * ## What must be excluded, or oldest-first becomes its own trap
 *
 * Oldest-first is only safe while every candidate can eventually *leave* the
 * set. A row that can never be billed stays a candidate for ever — and because
 * it is old, it sits at the head of the ordering by construction. Accumulate
 * `limit` of them and the pass returns nothing but sediment on every tick,
 * billing stops entirely, and `executionsBilled: 0` looks exactly like a quiet
 * install. Newest-first was immune to that and lost rows under a spike instead;
 * this query has to be immune to both, so it excludes each unbillable class in
 * SQL rather than letting the caller skip them in a loop.
 *
 * **`totalCostUsd > 0`** — `recordAgentSpend` returns `null` below its own
 * threshold, so a zero-cost run can never acquire a ledger row. (It also drops
 * a `NaN` cost, which `> 0` is false for: an unmapped model in the provider's
 * cost table would otherwise be permanent sediment.)
 *
 * **The space must still exist.** The query resolves the space a run is billed
 * to, in this order: the space key a run carries (phase 50: the space the run is
 * about), then `userId`, then the legacy `scope` key for runs the platform
 * scheduler fired before the cutover. Two shapes never resolve to a billable
 * owner: a system-owned row with no scope key at all, and — the one that
 * accumulates — a scope key naming a user who has since been erased. The
 * second is invisible to erasure's cascade, because `AiWorkflowExecution.userId`
 * is `onDelete: Cascade` and a system-owned row has `userId: null`, so the row
 * survives its owner with their id still in its `scope`. Handing that to
 * `recordAgentSpend` makes `ensureCreditAccount` fail its FK into
 * `ResparkableSpace` — a `P2003`, not the `P2002` the caller swallows — so it
 * logs an error and re-fetches the same row on the next tick, for ever.
 *
 * Excluding it here is not merely a drainage fix, it is the correct answer:
 * **there is nobody to bill.** The brain is gone, the credit account went with
 * it, and a debit against an erased person is not a thing that can be right.
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
    SELECT e."id", e."userId", e."totalCostUsd", s."spaceId" AS "spaceId", s."kind" AS "spaceKind"
    FROM "ai_workflow_execution" e
    JOIN "ai_workflow" w ON w."id" = e."workflowId"
    -- e."userId" is ai_workflow_execution.userId, a CORE column naming the
    -- person a run belongs to. It is NOT the tier's owner key and phase 45
    -- does not rename it: only s."spaceId", on the tier's own table, moved.
    -- Worth the comment, because a blanket rename of every "userId" in this
    -- file's SQL silently rewrites this one, after which the query matches
    -- nothing: it bills nobody and raises no error.
    --
    -- An inner join, so a run whose space no longer exists is not returned, and
    -- the space's kind comes back with the run rather than one lookup per row.
    JOIN "framework_resparkable_space" s ON s."spaceId" = COALESCE(
      -- The only place the billed space is decided: the space the run names
      -- first (phase 50 writes it on every queued run), then the person for a
      -- run queued before that, then the legacy key a pre-cutover scheduler row
      -- carried. ->> yields text, and a key that is not a string, or names no
      -- space, matches no row, so the run is not returned rather than billed
      -- somewhere by guesswork.
      e."scope"->>${RESPARKABLE_SCHEDULE_SPACE_KEY},
      e."userId",
      e."scope"->>${RESPARKABLE_SCHEDULE_OWNER_KEY}
    )
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
// See the file-level doc comment: intentionally not SpaceScope-shaped.

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
    where: { spaceId: { in: users.map((user) => user.id) } },
    select: { spaceId: true, balanceCredits: true },
  });
  const balanceByUserId = new Map(
    accounts.map((account) => [account.spaceId, account.balanceCredits])
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
  // `spaceScope()` is normally reserved for a *verified session's own*
  // identity (see its doc comment); the admin grant is the one legitimate
  // exception, minting a scope for a target user id that came from an
  // admin-only, Zod-validated request body rather than the caller's own
  // session. That is exactly why this call is confined to this
  // admin-only function rather than exposed as a general helper.
  const scope = spaceScope(userId);
  await ensureCreditAccount(scope);

  logger.info('Resparkable admin credit grant', { userId, amount, adminId });

  return applyLedgerEntry(scope, {
    kind: 'admin_grant',
    creditsDelta: amount,
    ...(note !== undefined ? { note } : {}),
    createdByAdminId: adminId,
    // The recipient did nothing; the admin is recorded in `createdByAdminId`.
    authorUserId: null,
  });
}
