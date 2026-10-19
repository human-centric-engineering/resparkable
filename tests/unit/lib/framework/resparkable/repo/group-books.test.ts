/**
 * Unit Tests: the read behind a group's books (phase 62).
 *
 * The books show money and nothing else, so the repo reads exactly one table,
 * the credit ledger, scoped to the group's space, and selects only the five
 * fields the books classify on.
 *
 * @see lib/framework/resparkable/repo/group-books.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { resparkableCreditLedgerEntry: { findMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { listGroupLedgerSince } from '@/lib/framework/resparkable/repo/group-books';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';

const SCOPE = spaceScopeFor({ spaceId: 'spc_group', actorUserId: 'user_a', role: 'member' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableCreditLedgerEntry.findMany).mockResolvedValue([]);
});

describe('listGroupLedgerSince', () => {
  it('reads the group space’s ledger from the given instant, oldest first', async () => {
    const since = new Date('2026-10-05T00:00:00Z');

    await listGroupLedgerSince(SCOPE, since);

    expect(prisma.resparkableCreditLedgerEntry.findMany).toHaveBeenCalledWith({
      where: { spaceId: 'spc_group', createdAt: { gte: since } },
      select: {
        kind: true,
        creditsDelta: true,
        createdByUserId: true,
        memberUserId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('selects no free-text or reference field, so nothing about output can reach the books', async () => {
    await listGroupLedgerSince(SCOPE, new Date());

    const call = vi.mocked(prisma.resparkableCreditLedgerEntry.findMany).mock.calls[0]?.[0];
    expect(Object.keys(call?.select ?? {}).sort()).toEqual([
      'createdAt',
      'createdByUserId',
      'creditsDelta',
      'kind',
      'memberUserId',
    ]);
  });

  it('returns the rows as the database gave them', async () => {
    const rows = [
      {
        kind: 'agent_spend',
        creditsDelta: -2,
        createdByUserId: 'user_a',
        memberUserId: null,
        createdAt: new Date('2026-10-06T00:00:00Z'),
      },
    ];
    vi.mocked(prisma.resparkableCreditLedgerEntry.findMany).mockResolvedValue(rows as never);

    expect(await listGroupLedgerSince(SCOPE, new Date())).toEqual(rows);
  });
});
