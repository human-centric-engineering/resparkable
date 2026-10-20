/**
 * The read behind a group's books (§23.12's second amendment, phase 62).
 *
 * Money only. This reads the group space's ledger and nothing else: no item,
 * task, message or event table is touched, which is the structural half of
 * "the books show money, never output" (test 13n asserts the rendered half).
 */

import { prisma } from '@/lib/db/client';
import { spaceWhere, type SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';

/** One ledger row as the books need it: who, how much, what kind, when. */
export interface BooksLedgerRow {
  kind: string;
  creditsDelta: number;
  createdByUserId: string | null;
  memberUserId: string | null;
  booksCategory: string | null;
  createdAt: Date;
}

/** Every ledger row in a group space since `since`, oldest first. */
export async function listGroupLedgerSince(
  scope: SpaceScope,
  since: Date
): Promise<BooksLedgerRow[]> {
  return prisma.resparkableCreditLedgerEntry.findMany({
    where: { ...spaceWhere(scope), createdAt: { gte: since } },
    select: {
      kind: true,
      creditsDelta: true,
      createdByUserId: true,
      memberUserId: true,
      booksCategory: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}
