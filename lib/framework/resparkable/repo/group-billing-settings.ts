/**
 * Group billing settings repo (phase 62): writes to who-pays settings and to a
 * member's own figures, each one a single statement or transaction.
 *
 * The money moves of a charge live in `repo/group-billing.ts`. This file holds
 * the slower writes around them: an admin's pending settings, a member's
 * allowance, the automatic top-up a member agrees to, a member filling their own
 * group balance, and the fallback when the operational payer goes.
 *
 * See `.context/framework/resparkable/phase-62-plan.md`.
 */

import { prisma } from '@/lib/db/client';
import { books } from '@/lib/framework/resparkable/repo/billing';
import type { GroupDb } from '@/lib/framework/resparkable/repo/groups';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { Prisma } from '@prisma/client';
import type { ResparkableGroup } from '@prisma/client';

/** The who-pays columns, as the settings service names them. */
export interface BillingColumns {
  seatPriceAdminCredits: number;
  seatPriceMemberCredits: number;
  seatPriceViewerCredits: number;
  operationalCostsPaidBy: string;
  operationalPayerUserId: string | null;
  activityCostsPaidBy: string;
  allowanceSource: string;
  shortfallPolicy: string;
}

/**
 * Copy a pending change whose start has passed into the columns, and clear it.
 *
 * Conditional on the pending row still being the one read (`pendingBillingFrom`
 * unchanged and passed), so the cycle job and an admin's next change cannot
 * both promote it, or promote one and lose the other. Returns whether it did.
 */
export async function promotePendingBilling(
  groupId: string,
  expectedFrom: Date,
  columns: BillingColumns,
  now: Date,
  db: GroupDb = prisma
): Promise<boolean> {
  const result = await db.resparkableGroup.updateMany({
    where: { id: groupId, pendingBillingFrom: { equals: expectedFrom, lte: now } },
    data: { ...columns, pendingBilling: Prisma.DbNull, pendingBillingFrom: null },
  });
  return result.count > 0;
}

/** Record a change to take effect at `from`, replacing any change already waiting. */
export async function setPendingBilling(
  groupId: string,
  pending: BillingColumns,
  from: Date
): Promise<ResparkableGroup> {
  return prisma.resparkableGroup.update({
    where: { id: groupId },
    data: {
      pendingBilling: { ...pending } satisfies Prisma.InputJsonObject,
      pendingBillingFrom: from,
    },
  });
}

/** Drop a change that has not started yet. */
export async function clearPendingBilling(groupId: string): Promise<ResparkableGroup> {
  return prisma.resparkableGroup.update({
    where: { id: groupId },
    data: { pendingBilling: Prisma.DbNull, pendingBillingFrom: null },
  });
}

/** Set or clear one joined member's monthly allowance. `false` when no such member. */
export async function updateMemberAllowance(
  groupId: string,
  userId: string,
  allowanceCredits: number | null
): Promise<boolean> {
  const result = await prisma.resparkableGroupMember.updateMany({
    where: { groupId, userId, joinedAt: { not: null } },
    data: { allowanceCredits },
  });
  return result.count > 0;
}

/** Set or clear the automatic top-up a member agrees to. Only ever their own. */
export async function updateMemberAutoTopUp(
  groupId: string,
  userId: string,
  autoTopUpMonthlyCredits: number | null
): Promise<boolean> {
  const result = await prisma.resparkableGroupMember.updateMany({
    where: { groupId, userId, joinedAt: { not: null } },
    data: { autoTopUpMonthlyCredits },
  });
  return result.count > 0;
}

/**
 * Move credits from a person's own balance into **their own balance in a
 * group** (phase 62). The sibling of `transferCreditsToGroup`, which fills the
 * pool: same refusal to overdraw, same two rows, but the group-side row names
 * the member whose balance it filled, and the money stays theirs (credited back
 * when they leave).
 *
 * `null` means their own balance did not cover it and nothing was written.
 */
export async function transferCreditsToMemberBalance(
  from: SpaceScope,
  group: SpaceScope,
  groupId: string,
  credits: number,
  note: string
): Promise<{ memberBalanceCredits: number } | null> {
  if (from.role !== 'owner' || !from.actorUserId) {
    throw new Error('transferCreditsToMemberBalance: the giver must own their own space');
  }
  const member = from.actorUserId;

  return prisma.$transaction(async (tx) => {
    const taken = await tx.resparkableCreditAccount.updateMany({
      where: { spaceId: from.spaceId, balanceCredits: { gte: credits } },
      data: { balanceCredits: { decrement: credits } },
    });
    if (taken.count === 0) return null;

    const filled = await tx.resparkableGroupMember.updateMany({
      where: { groupId, userId: member, joinedAt: { not: null } },
      data: { balanceCredits: { increment: credits } },
    });
    if (filled.count === 0) throw new Error('transferCreditsToMemberBalance: not a member');

    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: from.spaceId,
        createdByUserId: member,
        kind: 'transfer_out',
        creditsDelta: -credits,
        note,
      },
    });
    await tx.resparkableCreditLedgerEntry.create({
      data: {
        spaceId: group.spaceId,
        createdByUserId: member,
        memberUserId: member,
        kind: 'transfer_in',
        creditsDelta: credits,
        booksCategory: books('topUps'),
      },
    });

    const row = await tx.resparkableGroupMember.findUniqueOrThrow({
      where: { groupId_userId: { groupId, userId: member } },
      select: { balanceCredits: true },
    });
    return { memberBalanceCredits: row.balanceCredits };
  });
}

/**
 * The operational payer is going (left, removed, demoted, erased): the group's
 * operational costs fall back to the pool (§23.14 q10).
 *
 * Applies to the stored setting and to a pending change that names them, so a
 * change waiting for next month cannot bring them back as payer. Conditional on
 * the payer still being them, so it is a no-op for anybody else and safe to call
 * on every departure. Returns whether anything changed.
 */
export async function releaseOperationalPayer(
  groupId: string,
  userId: string,
  db: GroupDb = prisma
): Promise<boolean> {
  const stored = await db.resparkableGroup.updateMany({
    where: { id: groupId, operationalPayerUserId: userId },
    data: { operationalCostsPaidBy: 'pool', operationalPayerUserId: null },
  });

  const group = await db.resparkableGroup.findUnique({
    where: { id: groupId },
    select: { pendingBilling: true },
  });
  const pending = group?.pendingBilling;
  let pendingChanged = false;
  if (
    pending &&
    typeof pending === 'object' &&
    !Array.isArray(pending) &&
    pending.operationalPayerUserId === userId
  ) {
    await db.resparkableGroup.update({
      where: { id: groupId },
      data: {
        pendingBilling: {
          ...pending,
          operationalCostsPaidBy: 'pool',
          operationalPayerUserId: null,
        },
      },
    });
    pendingChanged = true;
  }
  return stored.count > 0 || pendingChanged;
}
