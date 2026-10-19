/**
 * Money when somebody leaves a group, or the group closes (phase 62,
 * decision 7). Every function here takes the caller's transaction: settling a
 * balance and removing the membership it lives on must commit together, or a
 * person could leave with their money still in the group, or be paid out and
 * still be in it.
 *
 * - A **positive** group balance goes back to the person's own balance.
 * - A **negative** one, a debt, moves onto the pool (`debt_absorbed`): the
 *   credits behind it were real model costs the operator has already paid, so
 *   cancelling it outright would leave the operator out of pocket. The group
 *   carries it instead.
 * - A **carved allowance** is a limit on the pool, not money, and goes nowhere.
 * - **Seats** are not refunded.
 * - On **deletion**, what is left in the pool goes back to the current members in
 *   proportion to what each put into it, never more than they put in. A pool
 *   below zero is reported, and the caller refuses the deletion (decided
 *   2026-10-19: a group cannot be deleted while it owes credits).
 *
 * See `.context/framework/resparkable/phase-62-plan.md`.
 */

import type { GroupDb } from '@/lib/framework/resparkable/repo/groups';

/** Smaller than any credit amount that matters, larger than float noise. */
const EPSILON = 1e-6;

export interface DepartureSettlement {
  /** Credits returned to the person's own balance. */
  creditedBack: number;
  /** A debt the pool took over. */
  debtAbsorbed: number;
}

/**
 * Settle one member's group balance as they go. Call it before the membership
 * row is deleted, inside the same transaction.
 *
 * `toOwnBalance: false` is erasure: the person's own account is being deleted in
 * the same transaction, so the money leaves with them exactly as their personal
 * balance does, and nothing is written to an account about to vanish. A debt is
 * absorbed by the pool either way.
 */
export async function settleMemberDeparture(
  db: GroupDb,
  input: { groupId: string; spaceId: string; userId: string; toOwnBalance: boolean }
): Promise<DepartureSettlement> {
  const { groupId, spaceId, userId } = input;
  const member = await db.resparkableGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { balanceCredits: true, joinedAt: true },
  });
  if (!member || member.joinedAt === null) return { creditedBack: 0, debtAbsorbed: 0 };
  const balance = member.balanceCredits;

  if (balance > EPSILON) {
    await db.resparkableGroupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { balanceCredits: 0 },
    });
    await db.resparkableCreditLedgerEntry.create({
      data: {
        spaceId,
        createdByUserId: userId,
        memberUserId: userId,
        kind: 'credit_back',
        creditsDelta: -balance,
      },
    });
    if (
      input.toOwnBalance &&
      (await creditOwnBalance(db, userId, balance, 'From a group you left'))
    ) {
      return { creditedBack: balance, debtAbsorbed: 0 };
    }
    return { creditedBack: 0, debtAbsorbed: 0 };
  }

  if (balance < -EPSILON) {
    const debt = -balance;
    await db.resparkableGroupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { balanceCredits: 0 },
    });
    await db.resparkableCreditAccount.upsert({
      where: { spaceId },
      create: { spaceId, balanceCredits: -debt },
      update: { balanceCredits: { decrement: debt } },
    });
    await db.resparkableCreditLedgerEntry.createMany({
      data: [
        // The member's debt is cleared...
        {
          spaceId,
          createdByUserId: userId,
          memberUserId: userId,
          kind: 'debt_absorbed',
          creditsDelta: debt,
        },
        // ...and the pool carries it.
        { spaceId, createdByUserId: userId, kind: 'debt_absorbed', creditsDelta: -debt },
      ],
    });
    return { creditedBack: 0, debtAbsorbed: debt };
  }

  return { creditedBack: 0, debtAbsorbed: 0 };
}

/**
 * Add credits to a person's own balance with a `credit_back` row. `false` when
 * they have no personal space to hold an account (somebody who joined a group by
 * invitation and never opened their own brain): the caller ensures one before
 * the transaction, so this is a backstop, and the credits are logged as not
 * returned rather than written against a row that cannot exist.
 */
async function creditOwnBalance(
  db: GroupDb,
  userId: string,
  credits: number,
  note: string
): Promise<boolean> {
  const space = await db.resparkableSpace.findUnique({
    where: { spaceId: userId },
    select: { spaceId: true },
  });
  if (!space) return false;
  await db.resparkableCreditAccount.upsert({
    where: { spaceId: userId },
    create: { spaceId: userId, balanceCredits: credits },
    update: { balanceCredits: { increment: credits } },
  });
  await db.resparkableCreditLedgerEntry.create({
    data: {
      spaceId: userId,
      createdByUserId: userId,
      kind: 'credit_back',
      creditsDelta: credits,
      note,
    },
  });
  return true;
}

export interface PoolClosure {
  /** What the group still owes once every member's debt has moved onto it. 0 if nothing. */
  owes: number;
  /** Credits returned to members' own balances, from their balances and the pool. */
  returned: number;
  /** Pool credits nobody had put in (an operator's grant, say), which go nowhere. */
  unreturned: number;
}

/**
 * Settle everybody's money before a group is deleted, inside the deleting
 * transaction.
 *
 * In order: each joined member's balance is settled as if they left (credited
 * back, or their debt moved onto the pool); then, if the pool is below zero, the
 * group owes that and nothing more is paid out, so the caller can refuse; else
 * what is left in the pool is returned to the current members in proportion to
 * what each put into it over the group's life, never more than they put in.
 *
 * `erasedUserId` is a member whose own account is going in the same transaction
 * (the last member erasing their account): their share is not written.
 */
export async function closeGroupPool(
  db: GroupDb,
  input: { groupId: string; spaceId: string; erasedUserId?: string | null }
): Promise<PoolClosure> {
  const { groupId, spaceId } = input;
  const members = await db.resparkableGroupMember.findMany({
    where: { groupId, joinedAt: { not: null } },
    select: { userId: true },
  });

  let returned = 0;
  for (const { userId } of members) {
    const settled = await settleMemberDeparture(db, {
      groupId,
      spaceId,
      userId,
      toOwnBalance: userId !== input.erasedUserId,
    });
    returned += settled.creditedBack;
  }

  const account = await db.resparkableCreditAccount.findUnique({ where: { spaceId } });
  const pool = account?.balanceCredits ?? 0;
  if (pool < -EPSILON) return { owes: -pool, returned, unreturned: 0 };
  if (pool <= EPSILON) return { owes: 0, returned, unreturned: 0 };

  // What each current member put into the pool: top-ups by hand and the
  // automatic ones a carved allowance takes, both pool-side rows they authored.
  const ids = members.map((member) => member.userId);
  const given = await db.resparkableCreditLedgerEntry.groupBy({
    by: ['createdByUserId'],
    where: {
      spaceId,
      memberUserId: null,
      kind: { in: ['transfer_in', 'auto_top_up'] },
      createdByUserId: { in: ids },
    },
    _sum: { creditsDelta: true },
  });
  const contributions = given
    .map((row) => ({ userId: row.createdByUserId, credits: row._sum.creditsDelta ?? 0 }))
    .filter((row): row is { userId: string; credits: number } => !!row.userId && row.credits > 0);
  const totalGiven = contributions.reduce((sum, row) => sum + row.credits, 0);

  let paidOut = 0;
  if (totalGiven > 0) {
    for (const { userId, credits } of contributions) {
      const share = Math.min(credits, (pool * credits) / totalGiven);
      if (share <= EPSILON || userId === input.erasedUserId) continue;
      if (await creditOwnBalance(db, userId, share, 'Your share of a closed group')) {
        paidOut += share;
      }
    }
  }
  if (paidOut > 0) {
    await db.resparkableCreditLedgerEntry.create({
      data: { spaceId, kind: 'credit_back', creditsDelta: -paidOut, note: 'Group closed' },
    });
  }

  return { owes: 0, returned: returned + paidOut, unreturned: Math.max(0, pool - paidOut) };
}
