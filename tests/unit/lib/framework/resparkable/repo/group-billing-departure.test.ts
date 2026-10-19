/**
 * Unit Tests: money settlement on member departure and group closure (Phase 62).
 *
 * The properties that matter: a leaver's positive balance is zeroed and moved to
 * their own account (never when erasing, never without a personal space); a
 * debt moves onto the pool as a paired `debt_absorbed` entry; closing a group
 * shares the remaining pool by contribution, capped at what each gave.
 *
 * @see lib/framework/resparkable/repo/group-billing-departure.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeGroupPool,
  settleMemberDeparture,
} from '@/lib/framework/resparkable/repo/group-billing-departure';
import type { GroupDb } from '@/lib/framework/resparkable/repo/groups';

interface MemberRow {
  balanceCredits: number;
  joinedAt: Date | null;
}

const memberFindUnique = vi.fn();
const memberFindMany = vi.fn();
const memberUpdate = vi.fn();
const ledgerCreate = vi.fn();
const ledgerCreateMany = vi.fn();
const ledgerGroupBy = vi.fn();
const accountFindUnique = vi.fn();
const accountUpsert = vi.fn();
const spaceFindUnique = vi.fn();

const db = {
  resparkableGroupMember: {
    findUnique: memberFindUnique,
    findMany: memberFindMany,
    update: memberUpdate,
  },
  resparkableCreditLedgerEntry: {
    create: ledgerCreate,
    createMany: ledgerCreateMany,
    groupBy: ledgerGroupBy,
  },
  resparkableCreditAccount: { findUnique: accountFindUnique, upsert: accountUpsert },
  resparkableSpace: { findUnique: spaceFindUnique },
} as unknown as GroupDb;

const joined = new Date('2026-01-01T00:00:00Z');
const input = { groupId: 'grp', spaceId: 'spc_group', userId: 'u1', toOwnBalance: true };

/** Serve member balances by user id, and every personal space as existing. */
function seedBalances(balances: Record<string, number>): void {
  memberFindUnique.mockImplementation(
    async (args: { where: { groupId_userId: { userId: string } } }): Promise<MemberRow> => ({
      balanceCredits: balances[args.where.groupId_userId.userId] ?? 0,
      joinedAt: joined,
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  spaceFindUnique.mockImplementation(async (args: { where: { spaceId: string } }) => ({
    spaceId: args.where.spaceId,
  }));
});

describe('settleMemberDeparture', () => {
  it('does nothing for a member who does not exist', async () => {
    memberFindUnique.mockResolvedValue(null);

    const result = await settleMemberDeparture(db, input);

    expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 0 });
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('does nothing for a pending member who has not joined', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: 50, joinedAt: null });

    const result = await settleMemberDeparture(db, input);

    expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 0 });
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('zeroes a positive balance and credits it to the person own account', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: 40, joinedAt: joined });

    const result = await settleMemberDeparture(db, input);

    expect(result).toEqual({ creditedBack: 40, debtAbsorbed: 0 });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: 'grp', userId: 'u1' } },
      data: { balanceCredits: 0 },
    });
    // Group side: a negative credit_back authored by and attributed to the member.
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: {
        spaceId: 'spc_group',
        createdByUserId: 'u1',
        memberUserId: 'u1',
        kind: 'credit_back',
        creditsDelta: -40,
      },
    });
    // Personal side: upsert incrementing their own account, plus a positive row.
    expect(spaceFindUnique).toHaveBeenCalledWith({
      where: { spaceId: 'u1' },
      select: { spaceId: true },
    });
    expect(accountUpsert).toHaveBeenCalledWith({
      where: { spaceId: 'u1' },
      create: { spaceId: 'u1', balanceCredits: 40 },
      update: { balanceCredits: { increment: 40 } },
    });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: 'u1',
        kind: 'credit_back',
        creditsDelta: 40,
      }),
    });
    expect(ledgerCreate).toHaveBeenCalledTimes(2);
  });

  it('returns creditedBack 0 and writes no personal row when the personal space is missing', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: 40, joinedAt: joined });
    spaceFindUnique.mockResolvedValue(null);

    const result = await settleMemberDeparture(db, input);

    expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 0 });
    // The group balance is still cleared and its side recorded.
    expect(memberUpdate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ spaceId: 'spc_group', creditsDelta: -40 }),
    });
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('writes no personal row when toOwnBalance is false (erasure)', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: 40, joinedAt: joined });

    const result = await settleMemberDeparture(db, { ...input, toOwnBalance: false });

    expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 0 });
    expect(memberUpdate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(spaceFindUnique).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('moves a negative balance onto the pool as paired debt_absorbed entries', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: -12, joinedAt: joined });

    const result = await settleMemberDeparture(db, input);

    expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 12 });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: 'grp', userId: 'u1' } },
      data: { balanceCredits: 0 },
    });
    expect(accountUpsert).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group' },
      create: { spaceId: 'spc_group', balanceCredits: -12 },
      update: { balanceCredits: { decrement: 12 } },
    });
    const rows = ledgerCreateMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        spaceId: 'spc_group',
        createdByUserId: 'u1',
        memberUserId: 'u1',
        kind: 'debt_absorbed',
        creditsDelta: 12,
      },
      { spaceId: 'spc_group', createdByUserId: 'u1', kind: 'debt_absorbed', creditsDelta: -12 },
    ]);
    expect(rows[1]).not.toHaveProperty('memberUserId');
    // A debt never touches the person's own account.
    expect(spaceFindUnique).not.toHaveBeenCalled();
  });

  it('absorbs a debt even when toOwnBalance is false', async () => {
    memberFindUnique.mockResolvedValue({ balanceCredits: -3, joinedAt: joined });

    const result = await settleMemberDeparture(db, { ...input, toOwnBalance: false });

    expect(result.debtAbsorbed).toBe(3);
    expect(accountUpsert).toHaveBeenCalledTimes(1);
  });

  it.each([5e-7, -5e-7, 0])(
    'treats float noise of %s as zero and writes nothing',
    async (noise) => {
      memberFindUnique.mockResolvedValue({ balanceCredits: noise, joinedAt: joined });

      const result = await settleMemberDeparture(db, input);

      expect(result).toEqual({ creditedBack: 0, debtAbsorbed: 0 });
      expect(memberUpdate).not.toHaveBeenCalled();
      expect(ledgerCreate).not.toHaveBeenCalled();
      expect(ledgerCreateMany).not.toHaveBeenCalled();
      expect(accountUpsert).not.toHaveBeenCalled();
    }
  );
});

describe('closeGroupPool', () => {
  const closeInput = { groupId: 'grp', spaceId: 'spc_group' };

  function members(...ids: string[]): void {
    memberFindMany.mockResolvedValue(ids.map((userId) => ({ userId })));
  }

  function gave(rows: Array<{ createdByUserId: string | null; sum: number | null }>): void {
    ledgerGroupBy.mockResolvedValue(
      rows.map((row) => ({
        createdByUserId: row.createdByUserId,
        _sum: { creditsDelta: row.sum },
      }))
    );
  }

  function upsertFor(spaceId: string): unknown {
    return accountUpsert.mock.calls.find((call) => call[0].where.spaceId === spaceId)?.[0];
  }

  it('settles every joined member before looking at the pool', async () => {
    members('a', 'b');
    seedBalances({ a: 10, b: -4 });
    accountFindUnique.mockResolvedValue({ balanceCredits: 0 });

    const result = await closeGroupPool(db, closeInput);

    expect(memberFindMany).toHaveBeenCalledWith({
      where: { groupId: 'grp', joinedAt: { not: null } },
      select: { userId: true },
    });
    expect(memberUpdate).toHaveBeenCalledTimes(2);
    // a's 10 went back to their own account; b's debt went to the pool.
    expect(upsertFor('a')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { increment: 10 } } })
    );
    expect(upsertFor('spc_group')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { decrement: 4 } } })
    );
    expect(result).toEqual({ owes: 0, returned: 10, unreturned: 0 });
  });

  it('reports what the group owes and pays nothing out when the pool is below zero', async () => {
    members('a');
    seedBalances({ a: 0 });
    accountFindUnique.mockResolvedValue({ balanceCredits: -7 });

    const result = await closeGroupPool(db, closeInput);

    expect(result).toEqual({ owes: 7, returned: 0, unreturned: 0 });
    expect(ledgerGroupBy).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('keeps the settled returns in the report even when the pool is owed', async () => {
    members('a');
    seedBalances({ a: 6 });
    accountFindUnique.mockResolvedValue({ balanceCredits: -2 });

    const result = await closeGroupPool(db, closeInput);

    expect(result).toEqual({ owes: 2, returned: 6, unreturned: 0 });
  });

  it.each([0, 5e-7, null])('pays nothing out when the pool is about zero (%s)', async (pool) => {
    members('a');
    seedBalances({ a: 0 });
    accountFindUnique.mockResolvedValue(pool === null ? null : { balanceCredits: pool });

    const result = await closeGroupPool(db, closeInput);

    expect(result).toEqual({ owes: 0, returned: 0, unreturned: 0 });
    expect(ledgerGroupBy).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('shares a short pool in proportion to contributions', async () => {
    members('a', 'b');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 20 });
    gave([
      { createdByUserId: 'a', sum: 30 },
      { createdByUserId: 'b', sum: 10 },
    ]);

    const result = await closeGroupPool(db, closeInput);

    expect(upsertFor('a')).toEqual({
      where: { spaceId: 'a' },
      create: { spaceId: 'a', balanceCredits: 15 },
      update: { balanceCredits: { increment: 15 } },
    });
    expect(upsertFor('b')).toEqual({
      where: { spaceId: 'b' },
      create: { spaceId: 'b', balanceCredits: 5 },
      update: { balanceCredits: { increment: 5 } },
    });
    expect(result).toEqual({ owes: 0, returned: 20, unreturned: 0 });
  });

  it('queries only pool-side top-ups by current members', async () => {
    members('a', 'b');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 20 });
    gave([{ createdByUserId: 'a', sum: 30 }]);

    await closeGroupPool(db, closeInput);

    expect(ledgerGroupBy).toHaveBeenCalledWith({
      by: ['createdByUserId'],
      where: {
        spaceId: 'spc_group',
        memberUserId: null,
        kind: { in: ['transfer_in', 'auto_top_up'] },
        createdByUserId: { in: ['a', 'b'] },
      },
      _sum: { creditsDelta: true },
    });
  });

  it('caps each share at what the member gave and leaves the surplus unreturned', async () => {
    members('a', 'b');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    gave([
      { createdByUserId: 'a', sum: 30 },
      { createdByUserId: 'b', sum: 10 },
    ]);

    const result = await closeGroupPool(db, closeInput);

    expect(upsertFor('a')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { increment: 30 } } })
    );
    expect(upsertFor('b')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { increment: 10 } } })
    );
    expect(result).toEqual({ owes: 0, returned: 40, unreturned: 60 });
  });

  it('writes one pool-side credit_back for the total paid out', async () => {
    members('a', 'b');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 20 });
    gave([
      { createdByUserId: 'a', sum: 30 },
      { createdByUserId: 'b', sum: 10 },
    ]);

    await closeGroupPool(db, closeInput);

    const poolCalls = ledgerCreate.mock.calls.filter(
      (call) => call[0].data.spaceId === 'spc_group'
    );
    expect(poolCalls).toHaveLength(1);
    expect(poolCalls[0][0].data).toEqual({
      spaceId: 'spc_group',
      kind: 'credit_back',
      creditsDelta: -20,
      note: 'Group closed',
    });
    expect(poolCalls[0][0].data).not.toHaveProperty('memberUserId');
  });

  it('gives the erased member no share and writes nothing to their account', async () => {
    members('a', 'b');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 20 });
    gave([
      { createdByUserId: 'a', sum: 30 },
      { createdByUserId: 'b', sum: 10 },
    ]);

    const result = await closeGroupPool(db, { ...closeInput, erasedUserId: 'b' });

    expect(upsertFor('b')).toBeUndefined();
    expect(upsertFor('a')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { increment: 15 } } })
    );
    const poolCall = ledgerCreate.mock.calls.find((call) => call[0].data.spaceId === 'spc_group');
    expect(poolCall?.[0].data.creditsDelta).toBe(-15);
    expect(result).toEqual({ owes: 0, returned: 15, unreturned: 5 });
  });

  it('does not credit an erased member their own balance on settlement', async () => {
    members('a');
    seedBalances({ a: 9 });
    accountFindUnique.mockResolvedValue({ balanceCredits: 0 });

    const result = await closeGroupPool(db, { ...closeInput, erasedUserId: 'a' });

    expect(result.returned).toBe(0);
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('ignores contributions with no author or that are not positive', async () => {
    members('a', 'b', 'c');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 10 });
    gave([
      { createdByUserId: null, sum: 500 },
      { createdByUserId: 'a', sum: 10 },
      { createdByUserId: 'b', sum: -5 },
      { createdByUserId: 'c', sum: 0 },
      { createdByUserId: 'a2', sum: null },
    ]);

    const result = await closeGroupPool(db, closeInput);

    // Only a counts: totalGiven is 10, the pool is 10, so a gets exactly 10.
    expect(accountUpsert).toHaveBeenCalledTimes(1);
    expect(upsertFor('a')).toEqual(
      expect.objectContaining({ update: { balanceCredits: { increment: 10 } } })
    );
    expect(result).toEqual({ owes: 0, returned: 10, unreturned: 0 });
  });

  it('returns the whole pool as unreturned when nobody contributed', async () => {
    members('a');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 25 });
    gave([]);

    const result = await closeGroupPool(db, closeInput);

    expect(result).toEqual({ owes: 0, returned: 0, unreturned: 25 });
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('leaves a contributor unpaid and unreturned when their personal space is missing', async () => {
    members('a');
    seedBalances({});
    accountFindUnique.mockResolvedValue({ balanceCredits: 10 });
    gave([{ createdByUserId: 'a', sum: 10 }]);
    spaceFindUnique.mockResolvedValue(null);

    const result = await closeGroupPool(db, closeInput);

    expect(result).toEqual({ owes: 0, returned: 0, unreturned: 10 });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});
