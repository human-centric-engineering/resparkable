/**
 * Group billing repo (§23.12's second amendment, phase 62): the writes that move
 * money inside a group space, each one a single transaction.
 *
 * `repo/billing.ts` moves one space's one account. This file moves the two kinds
 * of account a group holds: the **pool** (the group space's
 * `ResparkableCreditAccount`) and each **member's own group balance**
 * (`ResparkableGroupMember.balanceCredits`). A ledger row says which of the two
 * it moved through `memberUserId`: null is the pool, a user id is that member's
 * balance. Deciding *which* to move is the service's job
 * (`services/group-billing.ts`); this file only makes each move atomic.
 *
 * See `.context/framework/resparkable/phase-62-plan.md`.
 */

import { prisma } from '@/lib/db/client';
import type { LedgerEntryInput } from '@/lib/framework/resparkable/repo/billing';
import { books } from '@/lib/framework/resparkable/repo/billing';
import { spaceWhere, type SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { Prisma } from '@prisma/client';
import type { ResparkableGroup, ResparkableGroupMember } from '@prisma/client';

/** The spend fields a group debit carries, without the kind or the delta. */
export type SpendDetail = Omit<LedgerEntryInput, 'kind' | 'creditsDelta' | 'authorUserId'>;

/** A group, and the clock its month runs on (the group space's timezone). */
export type GroupWithClock = ResparkableGroup & { timezone: string };

/** The group that owns a space, with its timezone. `null` for a personal space. */
export async function findGroupWithClockBySpaceId(spaceId: string): Promise<GroupWithClock | null> {
  const group = await prisma.resparkableGroup.findFirst({
    where: { spaceId },
    include: { space: { select: { timezone: true } } },
  });
  if (!group) return null;
  const { space, ...rest } = group;
  return { ...rest, timezone: space.timezone };
}

/** One live (joined) membership, or `null`. */
export async function findJoinedMembership(
  groupId: string,
  userId: string
): Promise<ResparkableGroupMember | null> {
  return prisma.resparkableGroupMember.findFirst({
    where: { groupId, userId, joinedAt: { not: null } },
  });
}

/** Joined members holding one of `roles`, oldest first. */
export async function listJoinedMembersByRole(
  groupId: string,
  roles: readonly string[]
): Promise<ResparkableGroupMember[]> {
  return prisma.resparkableGroupMember.findMany({
    where: { groupId, joinedAt: { not: null }, role: { in: [...roles] } },
    orderBy: { joinedAt: 'asc' },
  });
}

/**
 * What the pool can still pay for: its balance less every member's debt.
 *
 * A member's unpaid debt lands on the pool if they leave (phase-62-plan.md
 * decision 7), so the pool is already promised to cover it. Reading the bare
 * balance would let the same credits be spent twice, once by whoever spends the
 * pool and again when the debt arrives. This is also what bounds the operator's
 * exposure under the `debt` policy: borrowing stops when the pool cannot back it.
 */
export async function poolAvailableCredits(scope: SpaceScope, groupId: string): Promise<number> {
  const [account, debts] = await Promise.all([
    prisma.resparkableCreditAccount.findUnique({ where: { spaceId: scope.spaceId } }),
    prisma.resparkableGroupMember.aggregate({
      where: { groupId, joinedAt: { not: null }, balanceCredits: { lt: 0 } },
      _sum: { balanceCredits: true },
    }),
  ]);
  return (account?.balanceCredits ?? 0) + (debts._sum.balanceCredits ?? 0);
}

/**
 * Credits a member has spent **from their own group balance** since `since`:
 * the filled allowance's monthly cap. Not an ACL, for `sumMemberSpendSince`'s
 * reason: one number about money, read by the billing service and nothing else.
 */
export async function sumMemberOwnSpendSince(
  scope: SpaceScope,
  memberUserId: string,
  since: Date
): Promise<number> {
  const result = await prisma.resparkableCreditLedgerEntry.aggregate({
    where: {
      ...spaceWhere(scope),
      kind: 'agent_spend',
      memberUserId,
      createdAt: { gte: since },
    },
    _sum: { creditsDelta: true },
  });
  return 0 - (result._sum.creditsDelta ?? 0);
}

/**
 * Debit the pool for a run a member started under a **carved** allowance: the
 * pool pays, and the member's remaining allowance goes down by the same amount.
 * One transaction, so the allowance can never disagree with the pool.
 */
export async function debitPoolWithinAllowance(
  scope: SpaceScope,
  groupId: string,
  memberUserId: string,
  credits: number,
  detail: SpendDetail
): Promise<{ poolBalanceAfter: number }> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.resparkableCreditAccount.update({
      where: { spaceId: scope.spaceId },
      data: { balanceCredits: { decrement: credits } },
    });
    await tx.resparkableGroupMember.updateMany({
      where: { groupId, userId: memberUserId },
      data: { allowanceRemainingCredits: { decrement: credits } },
    });
    await tx.resparkableCreditLedgerEntry.create({
      data: {
        ...detail,
        spaceId: scope.spaceId,
        createdByUserId: memberUserId,
        kind: 'agent_spend',
        creditsDelta: -credits,
        booksCategory: books('sharedActivity'),
      },
    });
    return { poolBalanceAfter: account.balanceCredits };
  });
}

/**
 * Debit one member's own group balance. It may go below zero: a run's cost is
 * real once it has been incurred, and the shortfall policy decides what a
 * negative balance means, not this write.
 *
 * `authorUserId` is who started the run, which differs from the member under
 * `one_admin` operational costs (nobody started the digest; the payer pays).
 */
export async function debitMemberBalance(
  scope: SpaceScope,
  groupId: string,
  memberUserId: string,
  credits: number,
  detail: SpendDetail,
  authorUserId: string | null
): Promise<{ balanceAfter: number } | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ balanceCredits: number }>>`
      UPDATE "framework_resparkable_group_member"
         SET "balanceCredits" = "balanceCredits" - ${credits}, "updatedAt" = now()
       WHERE "groupId" = ${groupId} AND "userId" = ${memberUserId}
         AND "joinedAt" IS NOT NULL
      RETURNING "balanceCredits"
    `;
    const row = rows[0];
    if (!row) return null;
    await tx.resparkableCreditLedgerEntry.create({
      data: {
        ...detail,
        spaceId: scope.spaceId,
        createdByUserId: authorUserId,
        memberUserId,
        kind: 'agent_spend',
        creditsDelta: -credits,
        // Nobody started it (the payer pays a running cost) or a member did.
        booksCategory: books(authorUserId === null ? 'runningCostsOwn' : 'ownActivity'),
      },
    });
    return { balanceAfter: row.balanceCredits };
  });
}

/**
 * Divide one run's cost into equal shares, one per joined member holding one of
 * `roles`, and debit each share from that member's own balance.
 *
 * **All or nothing** (§23.14 q8). The members are locked and counted inside the
 * transaction, so somebody joining or leaving mid-split is in all of it or none
 * of it, and a part-paid split is never visible. One `UPDATE` for every share
 * and one `INSERT` for every row, so a group of thirty is two statements, not
 * sixty.
 *
 * **Idempotency.** The ledger's `@@unique([kind, relatedWorkflowExecutionId])`
 * is what stops the billing pass charging a run twice. Only the first share
 * carries the execution id, so a repeat pass still collides on that one row and
 * the whole split rolls back; the other shares point at the run through `note`.
 *
 * Returns each payer's balance after, for the automatic top-up that follows.
 * An empty list means nobody holds those roles and nothing was written.
 */
export async function debitEqualSplit(
  scope: SpaceScope,
  groupId: string,
  roles: readonly string[],
  credits: number,
  detail: SpendDetail,
  authorUserId: string | null
): Promise<Array<{ userId: string; balanceAfter: number }>> {
  return prisma.$transaction(async (tx) => {
    const payers = await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "framework_resparkable_group_member"
       WHERE "groupId" = ${groupId} AND "joinedAt" IS NOT NULL
         AND "role" IN (${Prisma.join([...roles])})
       ORDER BY "joinedAt" ASC, "userId" ASC
         FOR NO KEY UPDATE
    `;
    if (payers.length === 0) return [];

    const share = credits / payers.length;
    const ids = payers.map((payer) => payer.userId);
    const after = await tx.$queryRaw<Array<{ userId: string; balanceCredits: number }>>`
      UPDATE "framework_resparkable_group_member"
         SET "balanceCredits" = "balanceCredits" - ${share}, "updatedAt" = now()
       WHERE "groupId" = ${groupId} AND "userId" IN (${Prisma.join(ids)})
      RETURNING "userId", "balanceCredits"
    `;

    const { relatedWorkflowExecutionId, note, ...rest } = detail;
    const pointer = relatedWorkflowExecutionId
      ? `Share of run ${relatedWorkflowExecutionId}`
      : (note ?? null);
    await tx.resparkableCreditLedgerEntry.createMany({
      data: ids.map((userId, index) => ({
        ...rest,
        spaceId: scope.spaceId,
        createdByUserId: authorUserId,
        memberUserId: userId,
        kind: 'agent_spend',
        creditsDelta: -share,
        booksCategory: books(authorUserId === null ? 'runningCostsOwn' : 'ownActivity'),
        ...(index === 0 && relatedWorkflowExecutionId
          ? { relatedWorkflowExecutionId, note: note ?? null }
          : { note: pointer }),
      })),
    });

    return after.map((row) => ({ userId: row.userId, balanceAfter: row.balanceCredits }));
  });
}

/** Where an automatic top-up lands. */
export type AutoTopUpTarget =
  /** The member's own group balance. */
  | 'member'
  /** The pool, raising the member's carved allowance by the same amount. */
  | 'pool_allowance';

/**
 * Move up to `maxCredits` from a member's own balance into the group, as the
 * automatic top-up they agreed to (§23.14 q7).
 *
 * The amount is what is left of their monthly figure, and never more than their
 * own balance holds: the personal balance is decremented only where it still
 * covers the amount, checked in the same statement, so a top-up cannot overdraw
 * it. `month` is the start of the group's current month; a membership whose
 * `autoTopUpMonth` is a different month has used none of it yet.
 *
 * Returns the credits moved (0 when nothing could be) and the member's group
 * balance after.
 */
export async function applyAutoTopUp(input: {
  personal: SpaceScope;
  group: SpaceScope;
  groupId: string;
  memberUserId: string;
  monthlyCredits: number;
  month: Date;
  target: AutoTopUpTarget;
}): Promise<{ moved: number; balanceAfter: number; allowanceRemainingAfter: number }> {
  const { personal, group, groupId, memberUserId, monthlyCredits, month, target } = input;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      Array<{
        balanceCredits: number;
        allowanceRemainingCredits: number;
        autoTopUpUsedCredits: number;
        autoTopUpMonth: Date | null;
      }>
    >`
      SELECT "balanceCredits", "allowanceRemainingCredits", "autoTopUpUsedCredits", "autoTopUpMonth"
        FROM "framework_resparkable_group_member"
       WHERE "groupId" = ${groupId} AND "userId" = ${memberUserId} AND "joinedAt" IS NOT NULL
         FOR NO KEY UPDATE
    `;
    const member = locked[0];
    if (!member) return { moved: 0, balanceAfter: 0, allowanceRemainingAfter: 0 };

    const sameMonth = member.autoTopUpMonth?.getTime() === month.getTime();
    const used = sameMonth ? member.autoTopUpUsedCredits : 0;
    const own = await tx.resparkableCreditAccount.findUnique({
      where: { spaceId: personal.spaceId },
    });
    const amount = Math.min(monthlyCredits - used, own?.balanceCredits ?? 0);
    const unchanged = {
      moved: 0,
      balanceAfter: member.balanceCredits,
      allowanceRemainingAfter: member.allowanceRemainingCredits,
    };
    if (!(amount > 0)) return unchanged;

    const taken = await tx.resparkableCreditAccount.updateMany({
      where: { spaceId: personal.spaceId, balanceCredits: { gte: amount } },
      data: { balanceCredits: { decrement: amount } },
    });
    if (taken.count === 0) return unchanged;

    const updated = await tx.resparkableGroupMember.update({
      where: { groupId_userId: { groupId, userId: memberUserId } },
      data: {
        autoTopUpUsedCredits: used + amount,
        autoTopUpMonth: month,
        ...(target === 'member'
          ? { balanceCredits: { increment: amount } }
          : { allowanceRemainingCredits: { increment: amount } }),
      },
    });
    if (target === 'pool_allowance') {
      await tx.resparkableCreditAccount.upsert({
        where: { spaceId: group.spaceId },
        create: { spaceId: group.spaceId, balanceCredits: amount },
        update: { balanceCredits: { increment: amount } },
      });
    }

    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: personal.spaceId,
        createdByUserId: memberUserId,
        kind: 'auto_top_up',
        creditsDelta: -amount,
        note: 'Automatic top-up to a group',
        booksCategory: books('none'),
      },
    });
    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: group.spaceId,
        createdByUserId: memberUserId,
        // Into the member's own balance, or into the pool (null).
        memberUserId: target === 'member' ? memberUserId : null,
        kind: 'auto_top_up',
        creditsDelta: amount,
        booksCategory: books('topUps'),
      },
    });

    return {
      moved: amount,
      balanceAfter: updated.balanceCredits,
      allowanceRemainingAfter: updated.allowanceRemainingCredits,
    };
  });
}
