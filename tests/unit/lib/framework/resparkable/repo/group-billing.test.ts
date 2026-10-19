/**
 * Unit Tests: the group billing repo (Phase 62).
 *
 * The properties that matter: a pool is read net of members' debts; a debit
 * that matches no joined member writes no ledger row; an equal split is
 * all-in-one-transaction with only the first row carrying the execution id
 * (the idempotency key); and an automatic top-up never moves more than the
 * remaining monthly figure or the personal balance, and never when the
 * conditional personal decrement matches nothing.
 *
 * @see lib/framework/resparkable/repo/group-billing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountFindUnique = vi.fn();
const accountUpdate = vi.fn();
const accountUpdateMany = vi.fn();
const accountUpsert = vi.fn();
const memberFindFirst = vi.fn();
const memberFindMany = vi.fn();
const memberAggregate = vi.fn();
const memberUpdate = vi.fn();
const memberUpdateMany = vi.fn();
const groupFindFirst = vi.fn();
const ledgerCreate = vi.fn();
const ledgerCreateMany = vi.fn();
const ledgerAggregate = vi.fn();
const transaction = vi.fn();
const queryRaw = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableGroup: { findFirst: (...args: unknown[]) => groupFindFirst(...args) },
    resparkableCreditAccount: {
      findUnique: (...args: unknown[]) => accountFindUnique(...args),
    },
    resparkableGroupMember: {
      findFirst: (...args: unknown[]) => memberFindFirst(...args),
      findMany: (...args: unknown[]) => memberFindMany(...args),
      aggregate: (...args: unknown[]) => memberAggregate(...args),
    },
    resparkableCreditLedgerEntry: {
      aggregate: (...args: unknown[]) => ledgerAggregate(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  applyAutoTopUp,
  debitEqualSplit,
  debitMemberBalance,
  debitPoolWithinAllowance,
  findGroupWithClockBySpaceId,
  findJoinedMembership,
  listJoinedMembersByRole,
  poolAvailableCredits,
  sumMemberOwnSpendSince,
} from '@/lib/framework/resparkable/repo/group-billing';

const groupScope = spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_m', role: 'member' });
const personalScope = spaceScopeFor({ spaceId: 'user_m', actorUserId: 'user_m', role: 'owner' });

beforeEach(() => {
  vi.resetAllMocks();
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: (...args: unknown[]) => queryRaw(...args),
      resparkableCreditAccount: {
        findUnique: (...args: unknown[]) => accountFindUnique(...args),
        update: (...args: unknown[]) => accountUpdate(...args),
        updateMany: (...args: unknown[]) => accountUpdateMany(...args),
        upsert: (...args: unknown[]) => accountUpsert(...args),
      },
      resparkableGroupMember: {
        update: (...args: unknown[]) => memberUpdate(...args),
        updateMany: (...args: unknown[]) => memberUpdateMany(...args),
      },
      resparkableCreditLedgerEntry: {
        create: (...args: unknown[]) => ledgerCreate(...args),
        createMany: (...args: unknown[]) => ledgerCreateMany(...args),
      },
    })
  );
});

describe('findGroupWithClockBySpaceId', () => {
  it('flattens the space timezone onto the group and drops the nested space', async () => {
    groupFindFirst.mockResolvedValue({
      id: 'g1',
      spaceId: 'spc_group',
      space: { timezone: 'Asia/Tokyo' },
    });

    const result = await findGroupWithClockBySpaceId('spc_group');

    expect(result).toEqual({ id: 'g1', spaceId: 'spc_group', timezone: 'Asia/Tokyo' });
    expect(result).not.toHaveProperty('space');
    expect(groupFindFirst).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group' },
      include: { space: { select: { timezone: true } } },
    });
  });

  it('returns null for a space that is not a group', async () => {
    groupFindFirst.mockResolvedValue(null);
    expect(await findGroupWithClockBySpaceId('user_x')).toBeNull();
  });
});

describe('membership reads', () => {
  it('findJoinedMembership only matches joined rows', async () => {
    memberFindFirst.mockResolvedValue(null);

    await findJoinedMembership('g1', 'u1');

    expect(memberFindFirst).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: 'u1', joinedAt: { not: null } },
    });
  });

  it('listJoinedMembersByRole copies the roles into an "in" filter, oldest first', async () => {
    memberFindMany.mockResolvedValue([]);

    await listJoinedMembersByRole('g1', ['admin', 'member']);

    expect(memberFindMany).toHaveBeenCalledWith({
      where: { groupId: 'g1', joinedAt: { not: null }, role: { in: ['admin', 'member'] } },
      orderBy: { joinedAt: 'asc' },
    });
  });
});

describe('poolAvailableCredits', () => {
  it('adds the (negative) sum of member debts to the pool balance', async () => {
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    memberAggregate.mockResolvedValue({ _sum: { balanceCredits: -30 } });

    expect(await poolAvailableCredits(groupScope, 'g1')).toBe(70);
  });

  it('asks the database for joined members below zero only, so credit balances never inflate the pool', async () => {
    accountFindUnique.mockResolvedValue({ balanceCredits: 10 });
    memberAggregate.mockResolvedValue({ _sum: { balanceCredits: null } });

    await poolAvailableCredits(groupScope, 'g1');

    expect(memberAggregate).toHaveBeenCalledWith({
      where: { groupId: 'g1', joinedAt: { not: null }, balanceCredits: { lt: 0 } },
      _sum: { balanceCredits: true },
    });
    expect(accountFindUnique).toHaveBeenCalledWith({ where: { spaceId: 'spc_group' } });
  });

  it('treats a missing account and no debts as zero', async () => {
    accountFindUnique.mockResolvedValue(null);
    memberAggregate.mockResolvedValue({ _sum: { balanceCredits: null } });

    expect(await poolAvailableCredits(groupScope, 'g1')).toBe(0);
  });

  it('can go negative when debts exceed the pool', async () => {
    accountFindUnique.mockResolvedValue({ balanceCredits: 5 });
    memberAggregate.mockResolvedValue({ _sum: { balanceCredits: -12 } });

    expect(await poolAvailableCredits(groupScope, 'g1')).toBe(-7);
  });
});

describe('sumMemberOwnSpendSince', () => {
  it('returns spend as a positive number and scopes the query to the member and window', async () => {
    const since = new Date('2026-10-01T00:00:00Z');
    ledgerAggregate.mockResolvedValue({ _sum: { creditsDelta: -12.5 } });

    expect(await sumMemberOwnSpendSince(groupScope, 'user_m', since)).toBe(12.5);
    expect(ledgerAggregate).toHaveBeenCalledWith({
      where: {
        spaceId: 'spc_group',
        kind: 'agent_spend',
        memberUserId: 'user_m',
        createdAt: { gte: since },
      },
      _sum: { creditsDelta: true },
    });
  });

  it('is zero (not -0) when nothing was spent', async () => {
    ledgerAggregate.mockResolvedValue({ _sum: { creditsDelta: null } });

    expect(Object.is(await sumMemberOwnSpendSince(groupScope, 'user_m', new Date()), 0)).toBe(true);
  });
});

describe('debitPoolWithinAllowance', () => {
  it('decrements the pool and the allowance and writes a pool row attributed to the member', async () => {
    accountUpdate.mockResolvedValue({ balanceCredits: 40 });
    memberUpdateMany.mockResolvedValue({ count: 1 });
    ledgerCreate.mockResolvedValue({});

    const result = await debitPoolWithinAllowance(groupScope, 'g1', 'user_m', 3, {
      note: 'chat',
      tokenCostUsd: 0.1,
    });

    expect(result).toEqual({ poolBalanceAfter: 40 });
    expect(accountUpdate).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group' },
      data: { balanceCredits: { decrement: 3 } },
    });
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: 'user_m' },
      data: { allowanceRemainingCredits: { decrement: 3 } },
    });
    const data = ledgerCreate.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      spaceId: 'spc_group',
      createdByUserId: 'user_m',
      kind: 'agent_spend',
      creditsDelta: -3,
      note: 'chat',
      tokenCostUsd: 0.1,
    });
    // A pool row: no member balance moved.
    expect(data).not.toHaveProperty('memberUserId');
  });
});

describe('debitMemberBalance', () => {
  it('returns null and writes no ledger row when no joined member row was updated', async () => {
    queryRaw.mockResolvedValue([]);

    const result = await debitMemberBalance(groupScope, 'g1', 'user_m', 2, {}, 'user_m');

    expect(result).toBeNull();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('binds the credits, group and member into the UPDATE', async () => {
    queryRaw.mockResolvedValue([{ balanceCredits: 8 }]);
    ledgerCreate.mockResolvedValue({});

    await debitMemberBalance(groupScope, 'g1', 'user_m', 2, {}, 'user_m');

    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('"joinedAt" IS NOT NULL');
    expect(values).toEqual([2, 'g1', 'user_m']);
  });

  it('writes a member row with memberUserId and the given author, and returns the balance after', async () => {
    queryRaw.mockResolvedValue([{ balanceCredits: -1.5 }]);
    ledgerCreate.mockResolvedValue({});

    const result = await debitMemberBalance(
      groupScope,
      'g1',
      'user_payer',
      2,
      { relatedWorkflowExecutionId: 'wx1' },
      null
    );

    expect(result).toEqual({ balanceAfter: -1.5 });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: {
        relatedWorkflowExecutionId: 'wx1',
        spaceId: 'spc_group',
        createdByUserId: null,
        memberUserId: 'user_payer',
        kind: 'agent_spend',
        creditsDelta: -2,
      },
    });
  });
});

describe('debitEqualSplit', () => {
  it('writes nothing when nobody holds the roles', async () => {
    queryRaw.mockResolvedValueOnce([]);

    const result = await debitEqualSplit(groupScope, 'g1', ['admin'], 9, {}, 'user_m');

    expect(result).toEqual([]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(ledgerCreateMany).not.toHaveBeenCalled();
  });

  it('divides the cost by the payer count and returns each payer balance after', async () => {
    queryRaw
      .mockResolvedValueOnce([{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }])
      .mockResolvedValueOnce([
        { userId: 'a', balanceCredits: 7 },
        { userId: 'b', balanceCredits: 8 },
        { userId: 'c', balanceCredits: -1 },
      ]);
    ledgerCreateMany.mockResolvedValue({ count: 3 });

    const result = await debitEqualSplit(groupScope, 'g1', ['admin', 'member'], 3, {}, 'a');

    // The UPDATE is bound to the per-head share, not the whole cost.
    const [, share] = queryRaw.mock.calls[1] as [unknown, number, ...unknown[]];
    expect(share).toBe(1);
    const rows = ledgerCreateMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.memberUserId, r.creditsDelta])).toEqual([
      ['a', -1],
      ['b', -1],
      ['c', -1],
    ]);
    expect(result).toEqual([
      { userId: 'a', balanceAfter: 7 },
      { userId: 'b', balanceAfter: 8 },
      { userId: 'c', balanceAfter: -1 },
    ]);
  });

  it('puts the execution id on the first row only; the rest carry a pointer note', async () => {
    queryRaw.mockResolvedValueOnce([{ userId: 'a' }, { userId: 'b' }]).mockResolvedValueOnce([
      { userId: 'a', balanceCredits: 1 },
      { userId: 'b', balanceCredits: 1 },
    ]);
    ledgerCreateMany.mockResolvedValue({ count: 2 });

    await debitEqualSplit(
      groupScope,
      'g1',
      ['admin'],
      4,
      { relatedWorkflowExecutionId: 'wx9', note: 'digest' },
      null
    );

    const rows = ledgerCreateMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      relatedWorkflowExecutionId: 'wx9',
      note: 'digest',
      createdByUserId: null,
      spaceId: 'spc_group',
      kind: 'agent_spend',
    });
    expect(rows[1]).not.toHaveProperty('relatedWorkflowExecutionId');
    expect(rows[1]).toMatchObject({
      note: 'Share of run wx9',
      createdByUserId: null,
      memberUserId: 'b',
    });
  });

  it('keeps the caller note on every row when there is no execution id, and stamps the author', async () => {
    queryRaw.mockResolvedValueOnce([{ userId: 'a' }, { userId: 'b' }]).mockResolvedValueOnce([]);
    ledgerCreateMany.mockResolvedValue({ count: 2 });

    await debitEqualSplit(groupScope, 'g1', ['member'], 2, { note: 'chat turn' }, 'user_author');

    const rows = ledgerCreateMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ note: 'chat turn', createdByUserId: 'user_author' });
      expect(row).not.toHaveProperty('relatedWorkflowExecutionId');
    }
  });

  it('stores a null note when there is neither note nor execution id', async () => {
    queryRaw.mockResolvedValueOnce([{ userId: 'a' }]).mockResolvedValueOnce([]);
    ledgerCreateMany.mockResolvedValue({ count: 1 });

    await debitEqualSplit(groupScope, 'g1', ['member'], 2, {}, 'a');

    const rows = ledgerCreateMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows[0]?.note).toBeNull();
  });
});

describe('applyAutoTopUp', () => {
  const month = new Date('2026-10-01T00:00:00Z');
  const base = {
    personal: personalScope,
    group: groupScope,
    groupId: 'g1',
    memberUserId: 'user_m',
    monthlyCredits: 20,
    month,
    target: 'member' as const,
  };

  function lockedMember(overrides: Record<string, unknown> = {}) {
    return {
      balanceCredits: 0,
      allowanceRemainingCredits: 0,
      autoTopUpUsedCredits: 0,
      autoTopUpMonth: month,
      ...overrides,
    };
  }

  it('returns zeros and writes nothing when the member is not joined', async () => {
    queryRaw.mockResolvedValue([]);

    const result = await applyAutoTopUp(base);

    expect(result).toEqual({ moved: 0, balanceAfter: 0, allowanceRemainingAfter: 0 });
    expect(accountUpdateMany).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('moves the smaller of the remaining monthly figure and the personal balance', async () => {
    queryRaw.mockResolvedValue([lockedMember({ autoTopUpUsedCredits: 15, balanceCredits: -2 })]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 3, allowanceRemainingCredits: 0 });
    ledgerCreate.mockResolvedValue({});

    const result = await applyAutoTopUp(base);

    // 20 - 15 = 5 left of the monthly figure, below the 100 on hand.
    expect(result).toEqual({ moved: 5, balanceAfter: 3, allowanceRemainingAfter: 0 });
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { spaceId: 'user_m', balanceCredits: { gte: 5 } },
      data: { balanceCredits: { decrement: 5 } },
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: 'g1', userId: 'user_m' } },
      data: { autoTopUpUsedCredits: 20, autoTopUpMonth: month, balanceCredits: { increment: 5 } },
    });
  });

  it('caps the amount at the personal balance when that is smaller', async () => {
    queryRaw.mockResolvedValue([lockedMember()]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 4 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 4, allowanceRemainingCredits: 0 });
    ledgerCreate.mockResolvedValue({});

    const result = await applyAutoTopUp(base);

    expect(result.moved).toBe(4);
    expect(memberUpdate.mock.calls[0]?.[0].data.autoTopUpUsedCredits).toBe(4);
  });

  it('treats a different autoTopUpMonth as zero used', async () => {
    queryRaw.mockResolvedValue([
      lockedMember({ autoTopUpUsedCredits: 20, autoTopUpMonth: new Date('2026-09-01T00:00:00Z') }),
    ]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 20, allowanceRemainingCredits: 0 });
    ledgerCreate.mockResolvedValue({});

    const result = await applyAutoTopUp(base);

    expect(result.moved).toBe(20);
    expect(memberUpdate.mock.calls[0]?.[0].data).toMatchObject({
      autoTopUpUsedCredits: 20,
      autoTopUpMonth: month,
    });
  });

  it('treats a never-used month (null) as zero used', async () => {
    queryRaw.mockResolvedValue([lockedMember({ autoTopUpUsedCredits: 99, autoTopUpMonth: null })]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 20, allowanceRemainingCredits: 0 });
    ledgerCreate.mockResolvedValue({});

    expect((await applyAutoTopUp(base)).moved).toBe(20);
  });

  it('moves nothing when the monthly figure is already used up', async () => {
    queryRaw.mockResolvedValue([lockedMember({ autoTopUpUsedCredits: 20, balanceCredits: -1 })]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });

    const result = await applyAutoTopUp(base);

    expect(result).toEqual({ moved: 0, balanceAfter: -1, allowanceRemainingAfter: 0 });
    expect(accountUpdateMany).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('moves nothing when the member has no personal account', async () => {
    queryRaw.mockResolvedValue([lockedMember()]);
    accountFindUnique.mockResolvedValue(null);

    expect((await applyAutoTopUp(base)).moved).toBe(0);
    expect(accountUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses without writing when the conditional personal decrement matches no rows', async () => {
    queryRaw.mockResolvedValue([lockedMember({ balanceCredits: 1, allowanceRemainingCredits: 2 })]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 50 });
    accountUpdateMany.mockResolvedValue({ count: 0 });

    const result = await applyAutoTopUp(base);

    expect(result).toEqual({ moved: 0, balanceAfter: 1, allowanceRemainingAfter: 2 });
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('writes one auto_top_up row on each side; the group side is the member balance', async () => {
    queryRaw.mockResolvedValue([lockedMember()]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 20, allowanceRemainingCredits: 0 });
    ledgerCreate.mockResolvedValue({});

    await applyAutoTopUp(base);

    expect(ledgerCreate).toHaveBeenCalledTimes(2);
    expect(ledgerCreate.mock.calls[0]?.[0].data).toEqual({
      spaceId: 'user_m',
      createdByUserId: 'user_m',
      kind: 'auto_top_up',
      creditsDelta: -20,
      note: 'Automatic top-up to a group',
    });
    expect(ledgerCreate.mock.calls[1]?.[0].data).toEqual({
      spaceId: 'spc_group',
      createdByUserId: 'user_m',
      memberUserId: 'user_m',
      kind: 'auto_top_up',
      creditsDelta: 20,
    });
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('with target pool_allowance credits the pool and raises the allowance, not the balance', async () => {
    queryRaw.mockResolvedValue([lockedMember()]);
    accountFindUnique.mockResolvedValue({ balanceCredits: 100 });
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdate.mockResolvedValue({ balanceCredits: 0, allowanceRemainingCredits: 20 });
    accountUpsert.mockResolvedValue({});
    ledgerCreate.mockResolvedValue({});

    const result = await applyAutoTopUp({ ...base, target: 'pool_allowance' });

    expect(result).toEqual({ moved: 20, balanceAfter: 0, allowanceRemainingAfter: 20 });
    const data = memberUpdate.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ allowanceRemainingCredits: { increment: 20 } });
    expect(data).not.toHaveProperty('balanceCredits');
    expect(accountUpsert).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group' },
      create: { spaceId: 'spc_group', balanceCredits: 20 },
      update: { balanceCredits: { increment: 20 } },
    });
    // The group-side row is a pool row (null member).
    expect(ledgerCreate.mock.calls[1]?.[0].data).toMatchObject({
      spaceId: 'spc_group',
      memberUserId: null,
      creditsDelta: 20,
    });
  });
});
