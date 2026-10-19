/**
 * The group's month turning over (phase 62): seats, carved allowances and a
 * pending settings change, settled in one transaction per group.
 *
 * See `services/group-billing.ts` (`settleGroupCycle`) for when it runs and
 * `.context/framework/resparkable/phase-62-plan.md` decision 6 for why.
 */

import { prisma } from '@/lib/db/client';
import type { BillingColumns } from '@/lib/framework/resparkable/repo/group-billing-settings';
import { Prisma } from '@prisma/client';

export interface SettleMonthsInput {
  groupId: string;
  spaceId: string;
  /** `cycleSettledThrough` as read. The claim only succeeds if it is unchanged. */
  expectedThrough: Date | null;
  /** The start of the month being settled up to. */
  through: Date;
  /** How many month starts are being settled at once (1 unless the job was late). */
  months: number;
  seatPrices: { admin: number; member: number; viewer: number };
  /** Add each member's allowance to what they have left of the pool. */
  creditCarvedAllowances: boolean;
  /** A pending change that starts at or before `through`, to copy into the columns. */
  promote: { from: Date; columns: BillingColumns } | null;
}

export interface SettleMonthsResult {
  /** `false` when another caller had already settled this month. */
  settled: boolean;
  seatsCharged: number;
  /** Members a seat left below zero, for their automatic top-up. */
  shortUserIds: string[];
}

/**
 * Settle one or more month starts for a group, or do nothing if somebody else
 * already has.
 *
 * **The claim comes first**: a conditional update of `cycleSettledThrough` from
 * the value read to the new month. The cycle job and a charge that found the
 * month unsettled can both get here; exactly one claim matches, and the other
 * returns `settled: false` having written nothing. So a seat is never charged
 * twice.
 *
 * Then, in order: a pending change is promoted (so the new month's seat prices
 * are the ones charged), carved allowances are added (unused allowance rolls
 * over, §23.14 q7), and each joined member is charged their role's seat price
 * from their own group balance into the pool. A seat may take a balance below
 * zero; what that means is the shortfall policy's business, not this write's.
 */
export async function settleGroupMonths(input: SettleMonthsInput): Promise<SettleMonthsResult> {
  const { groupId, spaceId, expectedThrough, through, months, seatPrices } = input;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.resparkableGroup.updateMany({
      where: { id: groupId, cycleSettledThrough: expectedThrough },
      data: {
        cycleSettledThrough: through,
        ...(input.promote
          ? { ...input.promote.columns, pendingBilling: Prisma.DbNull, pendingBillingFrom: null }
          : {}),
      },
    });
    if (claimed.count === 0) return { settled: false, seatsCharged: 0, shortUserIds: [] };

    if (input.creditCarvedAllowances) {
      await tx.$executeRaw`
        UPDATE "framework_resparkable_group_member"
           SET "allowanceRemainingCredits" = "allowanceRemainingCredits" + "allowanceCredits" * ${months},
               "updatedAt" = now()
         WHERE "groupId" = ${groupId} AND "joinedAt" IS NOT NULL AND "allowanceCredits" IS NOT NULL
      `;
    }

    const charged = await tx.$queryRaw<
      Array<{ userId: string; seat: number; balanceCredits: number }>
    >`
      UPDATE "framework_resparkable_group_member" m
         SET "balanceCredits" = m."balanceCredits" - p.seat, "updatedAt" = now()
        FROM (
          SELECT "userId",
                 (CASE "role" WHEN 'admin' THEN ${seatPrices.admin}::float8
                              WHEN 'viewer' THEN ${seatPrices.viewer}::float8
                              ELSE ${seatPrices.member}::float8 END) * ${months} AS seat
            FROM "framework_resparkable_group_member"
           WHERE "groupId" = ${groupId} AND "joinedAt" IS NOT NULL
        ) p
       WHERE m."groupId" = ${groupId} AND m."userId" = p."userId" AND p.seat > 0
      RETURNING m."userId", p.seat, m."balanceCredits"
    `;
    if (charged.length === 0) return { settled: true, seatsCharged: 0, shortUserIds: [] };

    const total = charged.reduce((sum, row) => sum + row.seat, 0);
    await tx.resparkableCreditAccount.upsert({
      where: { spaceId },
      create: { spaceId, balanceCredits: total },
      update: { balanceCredits: { increment: total } },
    });
    await tx.resparkableCreditLedgerEntry.createMany({
      data: charged.flatMap((row) => [
        // Out of the member's own balance...
        {
          spaceId,
          createdByUserId: row.userId,
          memberUserId: row.userId,
          kind: 'seat',
          creditsDelta: -row.seat,
        },
        // ...and into the pool.
        { spaceId, createdByUserId: row.userId, kind: 'seat', creditsDelta: row.seat },
      ]),
    });

    return {
      settled: true,
      seatsCharged: charged.length,
      shortUserIds: charged.filter((row) => row.balanceCredits < 0).map((row) => row.userId),
    };
  });
}
