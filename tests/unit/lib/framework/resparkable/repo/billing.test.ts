/**
 * Unit Tests: the billing repo (Phase 29).
 *
 * Two properties matter most, because this is the tier's one financial
 * primitive:
 *
 * **`ensureCreditAccount` is race-safe**, the same idiom as
 * `ensureResparkableSpace`: two parallel first-touches race on `userId
 * @unique`, and the loser must resolve to the winner's row rather than throw.
 *
 * **`applyLedgerEntry` is atomic.** The balance adjustment and the ledger row
 * are one `$transaction`: a partial write (balance moved, no ledger row, or
 * the reverse) must never be observable, and a caller must be able to rely on
 * `entry.creditsDelta` being exactly what the balance moved by.
 *
 * @see lib/framework/resparkable/repo/billing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
const findMany = vi.fn();
const ledgerCreate = vi.fn();
const userFindMany = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableCreditAccount: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
    resparkableCreditLedgerEntry: {
      create: (...args: unknown[]) => ledgerCreate(...args),
    },
    user: {
      findMany: (...args: unknown[]) => userFindMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  applyLedgerEntry,
  ensureCreditAccount,
  findCreditAccount,
  grantCreditsAsAdmin,
  listCreditAccountsForAdmin,
} from '@/lib/framework/resparkable/repo/billing';

const scope = ownerScope('user_a');

/** Prisma's unique-constraint violation, as the client actually throws it. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed on the fields: (`userId`)'), {
    code: 'P2002',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mirrors the real `prisma.$transaction(async (tx) => ...)` shape closely
  // enough for these tests: run the callback against a tx object backed by
  // the same mocked methods a real transaction client would expose.
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      resparkableCreditAccount: { update },
      resparkableCreditLedgerEntry: { create: ledgerCreate },
    })
  );
});

describe('ensureCreditAccount', () => {
  it('creates an account on first use', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'acct_1', userId: 'user_a', balanceCredits: 0 });

    const result = await ensureCreditAccount(scope);

    expect(result).toMatchObject({ userId: 'user_a' });
    expect(create).toHaveBeenCalledWith({ data: { userId: 'user_a', balanceCredits: 0 } });
  });

  it('funds the account at the given initial balance', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'acct_1', userId: 'user_a', balanceCredits: 50 });

    await ensureCreditAccount(scope, 50);

    expect(create).toHaveBeenCalledWith({ data: { userId: 'user_a', balanceCredits: 50 } });
  });

  it('returns the existing account without writing', async () => {
    findUnique.mockResolvedValue({ id: 'acct_1', userId: 'user_a', balanceCredits: 10 });

    const result = await ensureCreditAccount(scope);

    expect(result).toMatchObject({ id: 'acct_1' });
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves to the winner’s row when two first-touches race', async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'acct_winner', userId: 'user_a', balanceCredits: 0 });
    create.mockRejectedValue(uniqueViolation());

    const result = await ensureCreditAccount(scope);

    expect(result).toMatchObject({ id: 'acct_winner' });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('rethrows a create failure that is not a unique violation', async () => {
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(new Error('connection terminated'));

    await expect(ensureCreditAccount(scope)).rejects.toThrow('connection terminated');
  });
});

describe('findCreditAccount', () => {
  it('reads by the scope’s userId', async () => {
    findUnique.mockResolvedValue(null);

    await findCreditAccount(scope);

    expect(findUnique).toHaveBeenCalledWith({ where: { userId: 'user_a' } });
  });
});

describe('applyLedgerEntry', () => {
  it('adjusts the balance by exactly creditsDelta and writes a matching ledger row', async () => {
    ledgerCreate.mockResolvedValue({ id: 'ledger_1', kind: 'agent_spend', creditsDelta: -3.5 });

    await applyLedgerEntry(scope, {
      kind: 'agent_spend',
      creditsDelta: -3.5,
      tokenCostUsd: 3.5,
    });

    expect(update).toHaveBeenCalledWith({
      where: { userId: 'user_a' },
      data: { balanceCredits: { increment: -3.5 } },
    });
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: { kind: 'agent_spend', creditsDelta: -3.5, tokenCostUsd: 3.5, userId: 'user_a' },
    });
  });

  it('runs the balance update and the ledger write inside one transaction', async () => {
    ledgerCreate.mockResolvedValue({ id: 'ledger_1' });

    await applyLedgerEntry(scope, { kind: 'admin_grant', creditsDelta: 10 });

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates a P2002 from a colliding relatedWorkflowExecutionId, no swallowing here', async () => {
    // The idempotency guard's whole point is that this rejects; the Site B
    // tick job is the one place that catches it.
    transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(
      applyLedgerEntry(scope, {
        kind: 'agent_spend',
        creditsDelta: -1,
        relatedWorkflowExecutionId: 'exec_1',
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('grantCreditsAsAdmin', () => {
  it('ensures the target account exists before writing the grant', async () => {
    findUnique.mockResolvedValue({ id: 'acct_1', userId: 'user_b', balanceCredits: 0 });
    ledgerCreate.mockResolvedValue({ id: 'ledger_1' });

    await grantCreditsAsAdmin('user_b', 25, 'welcome bonus', 'admin_1');

    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user_b',
        kind: 'admin_grant',
        creditsDelta: 25,
        note: 'welcome bonus',
        createdByAdminId: 'admin_1',
      }),
    });
  });

  it('creates the account first when the target user has never touched billing', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'acct_new', userId: 'user_new', balanceCredits: 0 });
    ledgerCreate.mockResolvedValue({ id: 'ledger_1' });

    await grantCreditsAsAdmin('user_new', 10, undefined, 'admin_1');

    expect(create).toHaveBeenCalledWith({ data: { userId: 'user_new', balanceCredits: 0 } });
  });
});

describe('listCreditAccountsForAdmin', () => {
  it('includes a user with no credit account yet, at a balance of 0', async () => {
    userFindMany.mockResolvedValue([{ id: 'user_a', name: 'Ada', email: 'ada@example.com' }]);
    findMany.mockResolvedValue([]); // no account row for user_a

    const rows = await listCreditAccountsForAdmin();

    expect(rows).toEqual([
      { userId: 'user_a', balanceCredits: 0, userName: 'Ada', userEmail: 'ada@example.com' },
    ]);
  });

  it('merges balances by userId rather than assuming row order', async () => {
    userFindMany.mockResolvedValue([
      { id: 'user_a', name: 'Ada', email: 'ada@example.com' },
      { id: 'user_b', name: 'Bea', email: 'bea@example.com' },
    ]);
    // Deliberately out of order relative to `users`.
    findMany.mockResolvedValue([
      { userId: 'user_b', balanceCredits: 7 },
      { userId: 'user_a', balanceCredits: 3 },
    ]);

    const rows = await listCreditAccountsForAdmin();

    expect(rows.find((r) => r.userId === 'user_a')?.balanceCredits).toBe(3);
    expect(rows.find((r) => r.userId === 'user_b')?.balanceCredits).toBe(7);
  });

  it('short-circuits without a second query when there are no users', async () => {
    userFindMany.mockResolvedValue([]);

    const rows = await listCreditAccountsForAdmin();

    expect(rows).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
