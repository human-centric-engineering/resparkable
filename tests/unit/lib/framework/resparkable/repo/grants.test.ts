/**
 * Unit Tests: the grant repo — the owner's side of a named share.
 *
 * The queries are the contract here, so these assert on what is handed to
 * Prisma rather than on what comes back. Four things have to be true and none
 * of them shows up in a returned value:
 *
 *   1. **Every query carries the owner.** This is the layer that cannot express
 *      a cross-user read, and a `findUnique` by grant id would break that
 *      silently — it would return another person's grant, which the caller
 *      would then have to remember to check.
 *   2. **The upsert targets the unique triple**, not the id, so re-sharing with
 *      the same address on the same item is one statement with no
 *      read-then-write race and no chance of a second live grant.
 *   3. **`granteeUserId` only ever fills a null in.** Overwriting it from a
 *      fresh account lookup would let a re-registered address inherit somebody
 *      else's acceptance.
 *   4. **Revoke excludes already-revoked rows**, so a double press does not
 *      move the timestamp that answers "when did access stop?".
 *
 * @see lib/framework/resparkable/repo/grants.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => {
  const resparkableGrant = {
    upsert: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const client = {
    resparkableGrant,
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({ resparkableGrant });
      }
      return undefined;
    }),
  };
  return { prisma: client };
});

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  acceptGrant,
  findAccountIdForEmail,
  findGrantByInviteTokenHash,
  findOwnGrant,
  listOwnGrants,
  revokeGrant,
  stampInviteToken,
  updateGrant,
  upsertGrant,
} from '@/lib/framework/resparkable/repo/grants';

const OWNER = ownerScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

const CREATE = {
  entityType: 'project' as const,
  entityId: 'p_1',
  granteeEmail: 'b@example.com',
  granteeUserId: null,
  role: 'viewer' as const,
  includeTaskDetail: false,
  expiresAt: null,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'p_1',
    granteeUserId: null,
    granteeEmail: 'b@example.com',
    role: 'viewer',
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertGrant', () => {
  it('targets the unique triple, so re-sharing is an update not a second row', async () => {
    await upsertGrant(OWNER, CREATE);

    const args = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[0][0];
    expect(args.where).toEqual({
      entityType_entityId_granteeEmail: {
        entityType: 'project',
        entityId: 'p_1',
        granteeEmail: 'b@example.com',
      },
    });
  });

  it('takes the owner from the scope, never from the caller', async () => {
    await upsertGrant(OWNER, CREATE);

    const args = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[0][0];
    expect(args.create).toMatchObject({ userId: 'user_a' });
    // Never in the update payload: a grant's owner is fixed at creation, and a
    // writable one would make re-sharing a way to move a row between brains.
    expect(args.update).not.toHaveProperty('userId');
  });

  it('reinstates a revoked grant rather than leaving the press to do nothing', async () => {
    await upsertGrant(OWNER, CREATE);

    const args = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[0][0];
    expect(args.update).toMatchObject({ revokedAt: null });
  });

  it('does not reset acceptedAt when a role changes', async () => {
    await upsertGrant(OWNER, { ...CREATE, role: 'commenter' });

    const args = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[0][0];
    // A person who already bound their account should not have to do it again
    // because the owner changed what they can do.
    expect(args.update).not.toHaveProperty('acceptedAt');
  });

  it('only fills granteeUserId in — it never overwrites one', async () => {
    await upsertGrant(OWNER, CREATE);
    const withoutAccount = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[0][0];
    expect(withoutAccount.update).not.toHaveProperty('granteeUserId');

    await upsertGrant(OWNER, { ...CREATE, granteeUserId: 'user_b' });
    const withAccount = vi.mocked(prisma.resparkableGrant.upsert).mock.calls[1][0];
    expect(withAccount.update).toMatchObject({ granteeUserId: 'user_b' });
  });
});

describe('listOwnGrants', () => {
  it('scopes to the owner and filters expiry through isShareActive', async () => {
    vi.mocked(prisma.resparkableGrant.findMany).mockResolvedValue([
      row({ id: 'live' }),
      row({ id: 'expired', expiresAt: new Date('2026-08-01T00:00:00.000Z') }),
      row({ id: 'revoked', revokedAt: new Date('2026-08-10T00:00:00.000Z') }),
    ] as never);

    const grants = await listOwnGrants(OWNER, {}, NOW);

    expect(vi.mocked(prisma.resparkableGrant.findMany).mock.calls[0][0]?.where).toMatchObject({
      userId: 'user_a',
    });
    expect(grants.map((grant) => grant.id)).toEqual(['live']);
  });

  it('returns everything, including revoked, when asked', async () => {
    vi.mocked(prisma.resparkableGrant.findMany).mockResolvedValue([
      row({ id: 'live' }),
      row({ id: 'revoked', revokedAt: NOW }),
    ] as never);

    const grants = await listOwnGrants(OWNER, { includeInactive: true }, NOW);

    expect(grants.map((grant) => grant.id)).toEqual(['live', 'revoked']);
  });

  it('narrows to one item when asked, still scoped to the owner', async () => {
    await listOwnGrants(OWNER, { entityType: 'board', entityId: 'b_1' }, NOW);

    expect(vi.mocked(prisma.resparkableGrant.findMany).mock.calls[0][0]?.where).toEqual({
      userId: 'user_a',
      entityType: 'board',
      entityId: 'b_1',
    });
  });
});

describe('findOwnGrant', () => {
  it('uses findFirst with the owner, so another person’s id returns null', async () => {
    await findOwnGrant(OWNER, 'grant_x');

    // `findUnique({ where: { id } })` would return the row and leave the caller
    // to remember the ownership check. Not-found and not-yours are the same
    // answer, and the query is what makes that true.
    expect(vi.mocked(prisma.resparkableGrant.findFirst).mock.calls[0][0]?.where).toEqual({
      userId: 'user_a',
      id: 'grant_x',
    });
  });
});

describe('updateGrant', () => {
  it('scopes the update and reports whether anything moved', async () => {
    vi.mocked(prisma.resparkableGrant.updateMany).mockResolvedValue({ count: 0 });

    expect(await updateGrant(OWNER, 'grant_x', { role: 'commenter' })).toBe(false);
    expect(vi.mocked(prisma.resparkableGrant.updateMany).mock.calls[0][0].where).toEqual({
      userId: 'user_a',
      id: 'grant_x',
    });
  });
});

describe('revokeGrant', () => {
  it('excludes already-revoked rows, so a second press moves nothing', async () => {
    await revokeGrant(OWNER, 'grant_1', NOW);

    const args = vi.mocked(prisma.resparkableGrant.updateMany).mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user_a', id: 'grant_1', revokedAt: null });
    expect(args.data).toEqual({ revokedAt: NOW });
  });

  it('returns false when nothing moved', async () => {
    vi.mocked(prisma.resparkableGrant.updateMany).mockResolvedValue({ count: 0 });

    expect(await revokeGrant(OWNER, 'grant_1', NOW)).toBe(false);
  });
});

describe('stampInviteToken', () => {
  it('excludes revoked rows from the where, so a revoked grant cannot send a fresh invite', async () => {
    await stampInviteToken(OWNER, 'grant_1', 'digest_1', NOW);

    const args = vi.mocked(prisma.resparkableGrant.updateMany).mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user_a', id: 'grant_1', revokedAt: null });
    expect(args.data).toEqual({ inviteTokenHash: 'digest_1', inviteSentAt: NOW });
  });

  it('returns false when nothing moved', async () => {
    vi.mocked(prisma.resparkableGrant.updateMany).mockResolvedValue({ count: 0 });

    expect(await stampInviteToken(OWNER, 'grant_1', 'digest_1', NOW)).toBe(false);
  });
});

describe('findGrantByInviteTokenHash', () => {
  it('finds by the unique digest column', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ inviteTokenHash: 'digest_1' }) as never
    );

    await findGrantByInviteTokenHash('digest_1');

    expect(vi.mocked(prisma.resparkableGrant.findUnique).mock.calls[0][0]).toEqual({
      where: { inviteTokenHash: 'digest_1' },
    });
  });

  it('returns null for a revoked grant even when the digest matches', async () => {
    // Excluded here rather than by the caller, so an accepted revocation
    // cannot be undone by an old email still carrying the token.
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ inviteTokenHash: 'digest_1', revokedAt: NOW }) as never
    );

    await expect(findGrantByInviteTokenHash('digest_1')).resolves.toBeNull();
  });

  it('returns null for an unknown digest', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(null);

    await expect(findGrantByInviteTokenHash('nope')).resolves.toBeNull();
  });
});

describe('acceptGrant', () => {
  it('runs inside a transaction', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ acceptedAt: null }) as never
    );
    vi.mocked(prisma.resparkableGrant.update).mockResolvedValue(row() as never);

    await acceptGrant('grant_1', 'user_b', NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('sets acceptedAt when it is currently null', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ acceptedAt: null }) as never
    );
    vi.mocked(prisma.resparkableGrant.update).mockResolvedValue(row() as never);

    await acceptGrant('grant_1', 'user_b', NOW);

    const args = vi.mocked(prisma.resparkableGrant.update).mock.calls[0][0];
    expect(args.data.acceptedAt).toBe(NOW);
  });

  it('does not rewrite acceptedAt when it is already set — re-opening an old email is not a new introduction', async () => {
    const firstAccepted = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ acceptedAt: firstAccepted }) as never
    );
    vi.mocked(prisma.resparkableGrant.update).mockResolvedValue(row() as never);

    await acceptGrant('grant_1', 'user_b', NOW);

    const args = vi.mocked(prisma.resparkableGrant.update).mock.calls[0][0];
    expect(args.data.acceptedAt).toBe(firstAccepted);
    expect(args.data.acceptedAt).not.toBe(NOW);
  });

  it('clears the invite token on acceptance, so it is single-use', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ acceptedAt: null, inviteTokenHash: 'digest_1' }) as never
    );
    vi.mocked(prisma.resparkableGrant.update).mockResolvedValue(row() as never);

    await acceptGrant('grant_1', 'user_b', NOW);

    const args = vi.mocked(prisma.resparkableGrant.update).mock.calls[0][0];
    expect(args.data.inviteTokenHash).toBeNull();
    expect(args.data.granteeUserId).toBe('user_b');
    expect(args.where).toEqual({ id: 'grant_1' });
  });

  it('returns null, without writing, when the grant was revoked between lookup and write', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(
      row({ revokedAt: NOW }) as never
    );

    await expect(acceptGrant('grant_1', 'user_b', NOW)).resolves.toBeNull();
    expect(prisma.resparkableGrant.update).not.toHaveBeenCalled();
  });

  it('returns null, without writing, when the grant no longer exists', async () => {
    vi.mocked(prisma.resparkableGrant.findUnique).mockResolvedValue(null);

    await expect(acceptGrant('grant_x', 'user_b', NOW)).resolves.toBeNull();
    expect(prisma.resparkableGrant.update).not.toHaveBeenCalled();
  });
});

describe('findAccountIdForEmail', () => {
  it('lower-cases the address and selects only the id', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_b' } as never);

    expect(await findAccountIdForEmail('B@Example.COM')).toBe('user_b');

    const args = vi.mocked(prisma.user.findUnique).mock.calls[0][0];
    expect(args.where).toEqual({ email: 'b@example.com' });
    // Narrowed on purpose, so this cannot quietly grow into an account-detail
    // lookup for whoever imports it next.
    expect(args.select).toEqual({ id: true });
  });

  it('returns null for an address with no account', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    expect(await findAccountIdForEmail('nobody@example.com')).toBeNull();
  });
});
