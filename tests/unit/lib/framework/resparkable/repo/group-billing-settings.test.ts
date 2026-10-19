/**
 * Unit Tests: the group billing settings repo (phase 62).
 *
 * Properties that matter:
 *
 * **Promotion is conditional.** `promotePendingBilling` only matches the pending
 * row it read (`pendingBillingFrom` equal and passed) and clears pending in the
 * same write, so two racing promoters cannot both win.
 *
 * **A member's own-balance top-up never overdraws.** The personal decrement is
 * conditional on the balance covering it; when it matches nothing, nothing else
 * is written.
 *
 * **The payer fallback is targeted.** `releaseOperationalPayer` touches the
 * stored setting only when the payer is that user, rewrites a pending change
 * only when it names them, and reports whether anything changed.
 *
 * @see lib/framework/resparkable/repo/group-billing-settings.ts
 */

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const groupUpdateMany = vi.fn();
const groupUpdate = vi.fn();
const groupFindUnique = vi.fn();
const memberUpdateMany = vi.fn();
const memberFindUniqueOrThrow = vi.fn();
const accountUpdateMany = vi.fn();
const ledgerCreate = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/db/client', () => {
  const tx = {
    resparkableGroup: {
      updateMany: (...args: unknown[]) => groupUpdateMany(...args),
      update: (...args: unknown[]) => groupUpdate(...args),
      findUnique: (...args: unknown[]) => groupFindUnique(...args),
    },
    resparkableGroupMember: {
      updateMany: (...args: unknown[]) => memberUpdateMany(...args),
      findUniqueOrThrow: (...args: unknown[]) => memberFindUniqueOrThrow(...args),
    },
    resparkableCreditAccount: {
      updateMany: (...args: unknown[]) => accountUpdateMany(...args),
    },
    resparkableCreditLedgerEntry: {
      create: (...args: unknown[]) => ledgerCreate(...args),
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
        transaction();
        return fn(tx);
      },
    },
  };
});

import {
  clearPendingBilling,
  promotePendingBilling,
  releaseOperationalPayer,
  setPendingBilling,
  transferCreditsToMemberBalance,
  updateMemberAllowance,
  updateMemberAutoTopUp,
  type BillingColumns,
} from '@/lib/framework/resparkable/repo/group-billing-settings';
import { spaceScope, spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';

const COLUMNS: BillingColumns = {
  seatPriceAdminCredits: 5,
  seatPriceMemberCredits: 3,
  seatPriceViewerCredits: 1,
  operationalCostsPaidBy: 'one_admin',
  operationalPayerUserId: 'user_adm',
  activityCostsPaidBy: 'equal_split',
  allowanceSource: 'filled',
  shortfallPolicy: 'suspend',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('promotePendingBilling', () => {
  const expectedFrom = new Date('2026-11-01T00:00:00Z');
  const now = new Date('2026-11-02T00:00:00Z');

  it('copies the columns and clears pending, conditional on the pending start it read', async () => {
    groupUpdateMany.mockResolvedValue({ count: 1 });

    const promoted = await promotePendingBilling('grp_1', expectedFrom, COLUMNS, now);

    expect(promoted).toBe(true);
    expect(groupUpdateMany).toHaveBeenCalledWith({
      where: { id: 'grp_1', pendingBillingFrom: { equals: expectedFrom, lte: now } },
      data: {
        ...COLUMNS,
        pendingBilling: Prisma.DbNull,
        pendingBillingFrom: null,
      },
    });
  });

  it('reports false when the pending row was already promoted or replaced', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });

    expect(await promotePendingBilling('grp_1', expectedFrom, COLUMNS, now)).toBe(false);
  });
});

describe('setPendingBilling / clearPendingBilling', () => {
  it('stores the settings as JSON with their start, replacing what was waiting', async () => {
    const from = new Date('2026-12-01T00:00:00Z');
    groupUpdate.mockResolvedValue({ id: 'grp_1' });

    await setPendingBilling('grp_1', COLUMNS, from);

    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: 'grp_1' },
      data: { pendingBilling: COLUMNS, pendingBillingFrom: from },
    });
  });

  it('clears both pending columns', async () => {
    groupUpdate.mockResolvedValue({ id: 'grp_1' });

    await clearPendingBilling('grp_1');

    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: 'grp_1' },
      data: { pendingBilling: Prisma.DbNull, pendingBillingFrom: null },
    });
  });
});

describe('updateMemberAllowance / updateMemberAutoTopUp', () => {
  it('writes the allowance only on a joined row and reports a match', async () => {
    memberUpdateMany.mockResolvedValue({ count: 1 });

    const matched = await updateMemberAllowance('grp_1', 'user_b', 40);

    expect(matched).toBe(true);
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'grp_1', userId: 'user_b', joinedAt: { not: null } },
      data: { allowanceCredits: 40 },
    });
  });

  it('reports false when no joined member matches (pending or absent)', async () => {
    memberUpdateMany.mockResolvedValue({ count: 0 });

    expect(await updateMemberAllowance('grp_1', 'user_p', null)).toBe(false);
  });

  it('writes null to clear an allowance', async () => {
    memberUpdateMany.mockResolvedValue({ count: 1 });

    await updateMemberAllowance('grp_1', 'user_b', null);

    expect(memberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { allowanceCredits: null } })
    );
  });

  it('writes the auto top-up only on a joined row and reports a match', async () => {
    memberUpdateMany.mockResolvedValue({ count: 1 });

    const matched = await updateMemberAutoTopUp('grp_1', 'user_b', 25);

    expect(matched).toBe(true);
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'grp_1', userId: 'user_b', joinedAt: { not: null } },
      data: { autoTopUpMonthlyCredits: 25 },
    });
  });

  it('reports false for an auto top-up on a row that is not a joined member', async () => {
    memberUpdateMany.mockResolvedValue({ count: 0 });

    expect(await updateMemberAutoTopUp('grp_1', 'user_x', 25)).toBe(false);
  });
});

describe('transferCreditsToMemberBalance', () => {
  const from = spaceScope('user_a');
  const group = spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_a', role: 'admin' });

  it('throws, before any write, when the giver is not the owner of their own space', async () => {
    await expect(transferCreditsToMemberBalance(group, group, 'grp_1', 10, 'note')).rejects.toThrow(
      /must own their own space/
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(accountUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses with null and writes nothing when the personal balance does not cover it', async () => {
    accountUpdateMany.mockResolvedValue({ count: 0 });

    const result = await transferCreditsToMemberBalance(from, group, 'grp_1', 100, 'note');

    expect(result).toBeNull();
    // The decrement is conditional on the balance covering the amount.
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { spaceId: from.spaceId, balanceCredits: { gte: 100 } },
      data: { balanceCredits: { decrement: 100 } },
    });
    expect(memberUpdateMany).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('throws (rolling the transaction back) when the giver is not a joined member', async () => {
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdateMany.mockResolvedValue({ count: 0 });

    await expect(transferCreditsToMemberBalance(from, group, 'grp_1', 10, 'note')).rejects.toThrow(
      /not a member/
    );

    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('moves the credits into the member balance and writes both ledger rows', async () => {
    accountUpdateMany.mockResolvedValue({ count: 1 });
    memberUpdateMany.mockResolvedValue({ count: 1 });
    memberFindUniqueOrThrow.mockResolvedValue({ balanceCredits: 35 });

    const result = await transferCreditsToMemberBalance(from, group, 'grp_1', 10, 'Top-up');

    expect(result).toEqual({ memberBalanceCredits: 35 });
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { groupId: 'grp_1', userId: 'user_a', joinedAt: { not: null } },
      data: { balanceCredits: { increment: 10 } },
    });
    expect(ledgerCreate).toHaveBeenCalledTimes(2);
    expect(ledgerCreate).toHaveBeenNthCalledWith(1, {
      data: {
        spaceId: from.spaceId,
        createdByUserId: 'user_a',
        kind: 'transfer_out',
        creditsDelta: -10,
        note: 'Top-up',
      },
    });
    expect(ledgerCreate).toHaveBeenNthCalledWith(2, {
      data: {
        spaceId: 'spc_group',
        createdByUserId: 'user_a',
        memberUserId: 'user_a',
        kind: 'transfer_in',
        creditsDelta: 10,
      },
    });
  });
});

describe('releaseOperationalPayer', () => {
  it('moves a stored payer back to the pool, conditional on the payer being that user', async () => {
    groupUpdateMany.mockResolvedValue({ count: 1 });
    groupFindUnique.mockResolvedValue({ pendingBilling: null });

    const changed = await releaseOperationalPayer('grp_1', 'user_adm');

    expect(changed).toBe(true);
    expect(groupUpdateMany).toHaveBeenCalledWith({
      where: { id: 'grp_1', operationalPayerUserId: 'user_adm' },
      data: { operationalCostsPaidBy: 'pool', operationalPayerUserId: null },
    });
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it('rewrites a pending change that names them to the pool, keeping its other fields', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });
    groupFindUnique.mockResolvedValue({ pendingBilling: { ...COLUMNS } });

    const changed = await releaseOperationalPayer('grp_1', 'user_adm');

    expect(changed).toBe(true);
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: 'grp_1' },
      data: {
        pendingBilling: {
          ...COLUMNS,
          operationalCostsPaidBy: 'pool',
          operationalPayerUserId: null,
        },
      },
    });
  });

  it('leaves a pending change that names someone else untouched, and reports false', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });
    groupFindUnique.mockResolvedValue({
      pendingBilling: { ...COLUMNS, operationalPayerUserId: 'user_other' },
    });

    const changed = await releaseOperationalPayer('grp_1', 'user_adm');

    expect(changed).toBe(false);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it('ignores a pending value that is not an object', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });
    groupFindUnique.mockResolvedValue({ pendingBilling: ['user_adm'] });

    expect(await releaseOperationalPayer('grp_1', 'user_adm')).toBe(false);
    expect(groupUpdate).not.toHaveBeenCalled();
  });

  it('returns false when the group is gone and nothing matched', async () => {
    groupUpdateMany.mockResolvedValue({ count: 0 });
    groupFindUnique.mockResolvedValue(null);

    expect(await releaseOperationalPayer('grp_1', 'user_adm')).toBe(false);
  });

  it('reports true when both the stored payer and a pending change named them', async () => {
    groupUpdateMany.mockResolvedValue({ count: 1 });
    groupFindUnique.mockResolvedValue({ pendingBilling: { ...COLUMNS } });

    expect(await releaseOperationalPayer('grp_1', 'user_adm')).toBe(true);
    expect(groupUpdate).toHaveBeenCalledTimes(1);
  });
});
