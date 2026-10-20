/**
 * Unit Tests: the group's month turning over (Phase 62).
 *
 * The properties that matter: the conditional claim on `cycleSettledThrough`
 * decides whether anything else is written (a lost claim writes nothing, so a
 * seat is never charged twice); a pending change is promoted in the same claim;
 * carved allowances are only added when asked; and seat charges credit the pool
 * the total with a paired ledger row per member.
 *
 * @see lib/framework/resparkable/repo/group-billing-cycle.ts
 */

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const groupUpdateMany = vi.fn();
const accountUpsert = vi.fn();
const ledgerCreateMany = vi.fn();
const executeRaw = vi.fn();
const queryRaw = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: { $transaction: (...args: unknown[]) => transaction(...args) },
}));

import { settleGroupMonths } from '@/lib/framework/resparkable/repo/group-billing-cycle';
import type { BillingColumns } from '@/lib/framework/resparkable/repo/group-billing-settings';

const expectedThrough = new Date('2026-09-01T00:00:00Z');
const through = new Date('2026-10-01T00:00:00Z');

const baseInput = {
  groupId: 'grp',
  spaceId: 'spc_group',
  expectedThrough,
  through,
  monthStarts: [new Date('2026-10-05T00:00:00Z')],
  seatPrices: { admin: 5, member: 3, viewer: 1 },
  creditCarvedAllowances: false,
  promote: null,
};

/** Join the static parts of a tagged-template call so SQL can be asserted on. */
function sqlOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join('?');
}

beforeEach(() => {
  vi.resetAllMocks();
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      resparkableGroup: { updateMany: groupUpdateMany },
      resparkableCreditAccount: { upsert: accountUpsert },
      resparkableCreditLedgerEntry: { createMany: ledgerCreateMany },
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
    })
  );
  groupUpdateMany.mockResolvedValue({ count: 1 });
  queryRaw.mockResolvedValue([]);
});

describe('settleGroupMonths', () => {
  it('claims conditionally on the cycleSettledThrough that was read', async () => {
    await settleGroupMonths(baseInput);

    expect(groupUpdateMany).toHaveBeenCalledWith({
      where: { id: 'grp', cycleSettledThrough: expectedThrough },
      data: { cycleSettledThrough: through },
    });
  });

  it('returns settled false and writes nothing else when the claim matches no rows', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });

    const result = await settleGroupMonths({ ...baseInput, creditCarvedAllowances: true });

    expect(result).toEqual({ settled: false, seatsCharged: 0, shortUserIds: [] });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(ledgerCreateMany).not.toHaveBeenCalled();
  });

  it('writes the promoted columns and clears the pending change in the claim', async () => {
    const columns = { billingMode: 'seats' } as unknown as BillingColumns;

    await settleGroupMonths({
      ...baseInput,
      promote: { from: new Date('2026-10-01T00:00:00Z'), columns, expectedPending: columns },
    });

    expect(groupUpdateMany).toHaveBeenCalledWith({
      // The change being promoted must still be the one waiting: an admin who
      // replaced it since keeps theirs.
      where: {
        id: 'grp',
        cycleSettledThrough: expectedThrough,
        pendingBillingFrom: new Date('2026-10-01T00:00:00Z'),
        // The payload too: a change replaced within the month keeps its date.
        pendingBilling: { equals: { billingMode: 'seats' } },
      },
      data: {
        cycleSettledThrough: through,
        billingMode: 'seats',
        pendingBilling: Prisma.DbNull,
        pendingBillingFrom: null,
      },
    });
  });

  it('adds carved allowances only when asked, counting each member’s month starts after they joined', async () => {
    await settleGroupMonths({
      ...baseInput,
      creditCarvedAllowances: true,
      monthStarts: [new Date('2026-09-05T00:00:00Z'), new Date('2026-10-05T00:00:00Z')],
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const call = executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('"allowanceRemainingCredits" + "allowanceCredits"');
    expect(sqlOf(call)).toContain('WHERE s > "joinedAt"');
    // Naive UTC strings, compared with the zone-less joinedAt column.
    expect(call.slice(1)).toEqual([['2026-09-05T00:00:00.000', '2026-10-05T00:00:00.000'], 'grp']);
  });

  it('does not touch allowances when creditCarvedAllowances is false', async () => {
    await settleGroupMonths(baseInput);

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('charges each member a seat per month start after they joined, never for a month before', async () => {
    await settleGroupMonths({
      ...baseInput,
      monthStarts: [new Date('2026-09-05T00:00:00Z'), new Date('2026-10-05T00:00:00Z')],
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const call = queryRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('RETURNING');
    expect(sqlOf(call)).toContain('WHERE s > "joinedAt"');
    // admin, viewer, member (the CASE order), the month starts, then the group in both WHEREs.
    expect(call.slice(1)).toEqual([
      5,
      1,
      3,
      ['2026-09-05T00:00:00.000', '2026-10-05T00:00:00.000'],
      'grp',
      'grp',
    ]);
  });

  it('upserts nothing when no seat was charged', async () => {
    queryRaw.mockResolvedValue([]);

    const result = await settleGroupMonths(baseInput);

    expect(result).toEqual({ settled: true, seatsCharged: 0, shortUserIds: [] });
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(ledgerCreateMany).not.toHaveBeenCalled();
  });

  it('credits the pool the total and writes two seat rows per charged member', async () => {
    queryRaw.mockResolvedValue([
      { userId: 'u1', seat: 5, balanceCredits: 20 },
      { userId: 'u2', seat: 3, balanceCredits: 7 },
    ]);

    const result = await settleGroupMonths(baseInput);

    expect(accountUpsert).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group' },
      create: { spaceId: 'spc_group', balanceCredits: 8 },
      update: { balanceCredits: { increment: 8 } },
    });
    const rows = ledgerCreateMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        spaceId: 'spc_group',
        createdByUserId: 'u1',
        memberUserId: 'u1',
        kind: 'seat',
        creditsDelta: -5,
        booksCategory: 'seats',
      },
      {
        spaceId: 'spc_group',
        createdByUserId: 'u1',
        kind: 'seat',
        creditsDelta: 5,
        booksCategory: 'none',
      },
      {
        spaceId: 'spc_group',
        createdByUserId: 'u2',
        memberUserId: 'u2',
        kind: 'seat',
        creditsDelta: -3,
        booksCategory: 'seats',
      },
      {
        spaceId: 'spc_group',
        createdByUserId: 'u2',
        kind: 'seat',
        creditsDelta: 3,
        booksCategory: 'none',
      },
    ]);
    expect(rows[1]).not.toHaveProperty('memberUserId');
    expect(result).toEqual({ settled: true, seatsCharged: 2, shortUserIds: [] });
  });

  it('lists only the members a seat left below zero as short', async () => {
    queryRaw.mockResolvedValue([
      { userId: 'u1', seat: 5, balanceCredits: -1 },
      { userId: 'u2', seat: 3, balanceCredits: 0 },
      { userId: 'u3', seat: 3, balanceCredits: 4 },
      { userId: 'u4', seat: 1, balanceCredits: -0.5 },
    ]);

    const result = await settleGroupMonths(baseInput);

    expect(result.seatsCharged).toBe(4);
    expect(result.shortUserIds).toEqual(['u1', 'u4']);
  });
});
