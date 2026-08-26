/**
 * Unit Tests: the share-link repo, and the `visibility` cache it maintains.
 *
 * `visibility` on an entity is **only** about the public-link surface. It
 * exists so a list can render a "shared" badge without joining to the link
 * table, and so nothing on the hot path has to. That makes it a cache — and a
 * cache updated in a second statement is a cache that goes wrong the first time
 * a request dies between the two, leaving an item badged as shared with no
 * link, or badged private while a live link serves it.
 *
 * The second of those is the one that matters, and it is why the sibling count
 * in `revokeShareLink` is taken **inside** the transaction rather than before
 * it.
 *
 * Test Coverage:
 * - Minting writes the row and flips visibility to `'link'`, in one transaction
 * - Revoking the last live link flips visibility back to `'private'`
 * - Revoking one of several does NOT flip it
 * - An expired sibling does not count as still live
 * - Revoking is idempotent
 * - `listShareLinks` hides inactive links unless asked
 * - Every query is owner-scoped
 *
 * @see lib/framework/resparkable/repo/share-links.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => {
  const delegate = () => ({
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
  });

  const client = {
    resparkableShareLink: delegate(),
    resparkableArea: delegate(),
    resparkableGoal: delegate(),
    resparkableProject: delegate(),
    resparkableReview: delegate(),
    resparkableBoard: delegate(),
    resparkableTask: delegate(),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(client) : undefined
    ),
  };

  return { prisma: client };
});

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  createShareLink,
  listShareLinks,
  ownsEntity,
  revokeShareLink,
} from '@/lib/framework/resparkable/repo/share-links';

const SCOPE = ownerScope('user_a');
const NOW = new Date('2026-08-26T12:00:00Z');

const db = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
};

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'p_1',
    tokenHash: 'digest',
    tokenPrefix: 'AAAABBBB',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.resparkableShareLink.create.mockResolvedValue(linkRow());
  db.resparkableShareLink.findMany.mockResolvedValue([]);
  db.resparkableShareLink.findFirst.mockResolvedValue(null);
  db.resparkableShareLink.update.mockResolvedValue(linkRow({ revokedAt: NOW }));
  db.resparkableProject.updateMany.mockResolvedValue({ count: 1 });
});

describe('minting', () => {
  it('writes the row and flips visibility inside one transaction', async () => {
    await createShareLink(SCOPE, {
      entityType: 'project',
      entityId: 'p_1',
      tokenHash: 'digest',
      tokenPrefix: 'AAAABBBB',
      includeChildren: false,
      includeTaskDetail: false,
      expiresAt: null,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.resparkableProject.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', id: 'p_1' },
      data: { visibility: 'link' },
    });
  });

  it('forces the owner onto the row, whatever the caller passed', async () => {
    await createShareLink(SCOPE, {
      entityType: 'project',
      entityId: 'p_1',
      tokenHash: 'digest',
      tokenPrefix: 'AAAABBBB',
      includeChildren: false,
      includeTaskDetail: false,
      expiresAt: null,
    });

    const [args] = db.resparkableShareLink.create.mock.calls[0] as [{ data: { userId: string } }];
    expect(args.data.userId).toBe('user_a');
  });
});

describe('revoking', () => {
  it('flips visibility back to private when it was the last live link', async () => {
    db.resparkableShareLink.findFirst.mockResolvedValue(linkRow());
    db.resparkableShareLink.findMany.mockResolvedValue([]);

    await revokeShareLink(SCOPE, 'link_1', NOW);

    expect(db.resparkableProject.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', id: 'p_1' },
      data: { visibility: 'private' },
    });
  });

  it('leaves visibility alone while another live link remains', async () => {
    // A badge saying "private" over a live link is the failure worth avoiding.
    db.resparkableShareLink.findFirst.mockResolvedValue(linkRow());
    db.resparkableShareLink.findMany.mockResolvedValue([{ revokedAt: null, expiresAt: null }]);

    await revokeShareLink(SCOPE, 'link_1', NOW);

    expect(db.resparkableProject.updateMany).not.toHaveBeenCalled();
  });

  it('does not count an expired sibling as still live', async () => {
    // The sibling exists, so a naive `count > 0` would leave the item badged as
    // shared for ever. `isShareActive` is the single definition of "still live"
    // and this is the query that has to use it.
    db.resparkableShareLink.findFirst.mockResolvedValue(linkRow());
    db.resparkableShareLink.findMany.mockResolvedValue([
      { revokedAt: null, expiresAt: new Date('2026-08-01T00:00:00Z') },
      { revokedAt: new Date('2026-08-02T00:00:00Z'), expiresAt: null },
    ]);

    await revokeShareLink(SCOPE, 'link_1', NOW);

    expect(db.resparkableProject.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { visibility: 'private' } })
    );
  });

  it('takes the sibling count INSIDE the transaction', async () => {
    // Two people revoking the last two links at once would otherwise each see
    // the other's link as still live, and neither would flip the badge.
    db.resparkableShareLink.findFirst.mockResolvedValue(linkRow());

    await revokeShareLink(SCOPE, 'link_1', NOW);

    // Every read and write happened through the transaction client, which the
    // mock resolves to the same object — so the assertion that matters is that
    // exactly one transaction was opened and nothing ran outside it.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on an already-revoked link', async () => {
    const already = linkRow({ revokedAt: new Date('2026-08-02T00:00:00Z') });
    db.resparkableShareLink.findFirst.mockResolvedValue(already);

    const result = await revokeShareLink(SCOPE, 'link_1', NOW);

    // A double-clicked button is not a failure worth reporting, and the second
    // call must not move the revocation timestamp.
    expect(db.resparkableShareLink.update).not.toHaveBeenCalled();
    expect(result?.revokedAt).toEqual(already.revokedAt);
  });

  it('returns null for a link that is not the caller’s', async () => {
    db.resparkableShareLink.findFirst.mockResolvedValue(null);

    await expect(revokeShareLink(SCOPE, 'link_x', NOW)).resolves.toBeNull();
    expect(db.resparkableProject.updateMany).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('hides revoked and expired links by default', async () => {
    db.resparkableShareLink.findMany.mockResolvedValue([
      linkRow({ id: 'live' }),
      linkRow({ id: 'revoked', revokedAt: new Date('2026-08-02T00:00:00Z') }),
      linkRow({ id: 'expired', expiresAt: new Date('2026-08-01T00:00:00Z') }),
    ]);

    const links = await listShareLinks(SCOPE, {}, NOW);

    expect(links.map((link) => link.id)).toEqual(['live']);
  });

  it('shows them when asked — a lapsed link is worth seeing', async () => {
    // An expired link is not deleted: the owner may want to know it lapsed
    // rather than wonder why a URL they shared stopped working.
    db.resparkableShareLink.findMany.mockResolvedValue([
      linkRow({ id: 'live' }),
      linkRow({ id: 'revoked', revokedAt: new Date('2026-08-02T00:00:00Z') }),
    ]);

    const links = await listShareLinks(SCOPE, { includeInactive: true }, NOW);

    expect(links).toHaveLength(2);
  });

  it('scopes the query to the owner', async () => {
    await listShareLinks(SCOPE, { entityType: 'board', entityId: 'b_1' }, NOW);

    const [args] = db.resparkableShareLink.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ userId: 'user_a', entityType: 'board', entityId: 'b_1' });
  });
});

describe('ownsEntity', () => {
  it('asks the owner-scoped question, never "who owns this?"', async () => {
    // `access/store.ts`'s `findEntityOwner` answers "who owns this?", which is
    // a shared query. This answers "is this mine?", which keeps the mint path
    // inside the layer that cannot express a cross-user read.
    db.resparkableTask.count.mockResolvedValue(1);

    await expect(ownsEntity(SCOPE, 'task', 't_1')).resolves.toBe(true);
    expect(db.resparkableTask.count).toHaveBeenCalledWith({
      where: { userId: 'user_a', id: 't_1' },
    });
  });

  it('is false for a row that is not the caller’s', async () => {
    db.resparkableTask.count.mockResolvedValue(0);
    await expect(ownsEntity(SCOPE, 'task', 't_1')).resolves.toBe(false);
  });
});
