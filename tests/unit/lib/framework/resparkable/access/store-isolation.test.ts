/**
 * Unit Tests: the shape of every query the sharing layer makes (phase 10).
 *
 * `resolve.test.ts` next door asserts the decisions. This asserts the
 * **queries**, and it is a different failure: a resolver can be perfectly
 * correct about who should see what and still leak, if the query it asks is
 * broader than the question.
 *
 * `access/**` is the second of the two layers allowed to touch Prisma (D5), and
 * it is the one that reads across users on purpose. That makes it the place a
 * missing predicate does the most damage — the repo layer's `OwnerScope` cannot
 * express a cross-user read at all, and this layer's whole job is to express
 * exactly one, following a grant or a link and nothing else.
 *
 * Two invariants, asserted over the real `where` objects handed to Prisma:
 *
 *   1. **Every grant read is bounded by the VIEWER's identity.** A grant query
 *      with no grantee predicate returns other people's grants, and the
 *      resolver would then happily follow one.
 *   2. **Every cascade read is bounded by the OWNER.** A cascade only ever runs
 *      inside one brain; a lookup that forgot `userId` could join a task in one
 *      person's brain to a board in another's.
 *
 * Test Coverage:
 * - Grant reads carry both a grantee predicate and `revokedAt: null`
 * - A viewer with no identity at all produces NO query, not an unbounded one
 * - Refs are matched as (type, id) pairs, never by id alone
 * - The grantee OR and the refs OR are ANDed, never merged into one OR
 * - Owner lookups select only the id and the owner column
 * - Every cascade lookup filters on the owner
 * - A share link is looked up by digest, never by plaintext
 *
 * @see lib/framework/resparkable/access/store.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The delegate list is inlined inside the factory rather than referenced from a
// const: `vi.mock` is hoisted above every declaration in the file, so a
// reference here is a TDZ error. Same shape as
// `privacy/subject-export-behaviour.test.ts`, which learned this the same way.
vi.mock('@/lib/db/client', () => ({
  prisma: Object.fromEntries(
    [
      'resparkableArea',
      'resparkableGoal',
      'resparkableProject',
      'resparkableReview',
      'resparkableBoard',
      'resparkableTask',
      'resparkableBoardCard',
      'resparkableGrant',
      'resparkableShareLink',
    ].map((model) => [
      model,
      { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    ])
  ),
}));

import { prisma } from '@/lib/db/client';
import {
  findBoardsPinningTasks,
  findEntityOwners,
  findFilterBoards,
  findGoalParents,
  findLiveGrantsForRefs,
  findLiveGrantsForViewer,
  findLiveShareLinkByTokenHash,
  findTaskFacts,
} from '@/lib/framework/resparkable/access/store';
import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';

const VIEWER = { userId: 'user_b', email: 'B@Example.com' };
const OWNER = 'user_a';

/** The mocked delegates, typed for the two methods this suite inspects. */
const prismaMock = prisma as unknown as Record<
  string,
  { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> }
>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const value of Object.values(prismaMock)) {
    value.findMany.mockResolvedValue([]);
    value.findUnique.mockResolvedValue(null);
  }
});

/** The `where` handed to a delegate's most recent `findMany`. */
function lastWhere(name: string): Record<string, unknown> {
  const calls = prismaMock[name].findMany.mock.calls;
  return (calls[calls.length - 1]?.[0] as { where: Record<string, unknown> })?.where;
}

describe('grant reads are bounded by the viewer', () => {
  it('filters on both halves of the grantee identity, lower-casing the email', async () => {
    // A grant is issued to an EMAIL and only gains a `granteeUserId` when it is
    // accepted, so someone whose account exists but who never opened the invite
    // is found by the address alone. Matching both is what makes the
    // "you already had an account" path work without a second table.
    await findLiveGrantsForViewer(VIEWER);

    expect(lastWhere('resparkableGrant')).toEqual({
      revokedAt: null,
      OR: [{ granteeUserId: 'user_b' }, { granteeEmail: 'b@example.com' }],
    });
  });

  it('makes NO query at all for a viewer with neither id nor email', async () => {
    // The failure this prevents is total: an `OR: []` matches every grant in
    // the install, and the resolver would follow whichever one came back.
    await findLiveGrantsForViewer({ userId: null, email: null });
    await findLiveGrantsForRefs({ userId: null, email: null }, [
      { entityType: 'project', entityId: 'p_1' },
    ]);

    expect(prismaMock.resparkableGrant.findMany).not.toHaveBeenCalled();
  });

  it('ANDs the grantee clause with the refs clause, never merging the two ORs', async () => {
    // The specific mistake worth a test: one `OR` key holding both sets matches
    // a grant to ANYONE on one of these refs. That is the leak this whole layer
    // exists to prevent, and it is one keystroke away.
    await findLiveGrantsForRefs(VIEWER, [
      { entityType: 'project', entityId: 'p_1' },
      { entityType: 'board', entityId: 'b_1' },
    ]);

    const where = lastWhere('resparkableGrant');

    expect(where.OR).toBeUndefined();
    expect(where.revokedAt).toBeNull();
    expect(where.AND).toEqual([
      { OR: [{ granteeUserId: 'user_b' }, { granteeEmail: 'b@example.com' }] },
      {
        OR: [
          { entityType: 'project', entityId: 'p_1' },
          { entityType: 'board', entityId: 'b_1' },
        ],
      },
    ]);
  });

  it('matches refs as (type, id) pairs rather than by id alone', async () => {
    await findLiveGrantsForRefs(VIEWER, [{ entityType: 'project', entityId: 'p_1' }]);

    const where = lastWhere('resparkableGrant');
    const refClause = (where.AND as Array<{ OR: unknown[] }>)[1];

    // `entityId: { in: [...] }` with no type predicate would let a board id be
    // read as a grant on a task that happens to share it.
    for (const clause of refClause.OR as Array<Record<string, unknown>>) {
      expect(clause).toHaveProperty('entityType');
      expect(clause).toHaveProperty('entityId');
    }
  });

  it('makes no query for an empty ref list', async () => {
    await findLiveGrantsForRefs(VIEWER, []);
    expect(prismaMock.resparkableGrant.findMany).not.toHaveBeenCalled();
  });
});

describe('owner lookups', () => {
  it('select only the id and the column the decision turns on', async () => {
    await findEntityOwners('project', ['p_1', 'p_2']);

    const [args] = prismaMock.resparkableProject.findMany.mock.calls[0] as [
      { where: unknown; select: unknown },
    ];

    // Fetching the row to compare one column would put a user's entire note
    // body on the wire for an authorisation check.
    expect(args.select).toEqual({ id: true, userId: true });
    expect(args.where).toEqual({ id: { in: ['p_1', 'p_2'] } });
  });

  it('route each shareable type to its own table', async () => {
    await findEntityOwners('area', ['a_1']);
    await findEntityOwners('goal', ['g_1']);
    await findEntityOwners('review', ['r_1']);
    await findEntityOwners('board', ['b_1']);
    await findEntityOwners('task', ['t_1']);

    expect(prismaMock.resparkableArea.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.resparkableGoal.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.resparkableReview.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.resparkableBoard.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.resparkableTask.findMany).toHaveBeenCalledTimes(1);
  });

  it('makes no query for an empty id list', async () => {
    await findEntityOwners('project', []);
    expect(prismaMock.resparkableProject.findMany).not.toHaveBeenCalled();
  });
});

describe('cascade reads are bounded by the owner', () => {
  it('every one of them filters on userId', async () => {
    await findTaskFacts(OWNER, ['t_1']);
    expect(lastWhere('resparkableTask')).toMatchObject({ userId: OWNER });

    await findGoalParents(OWNER, ['g_1']);
    expect(lastWhere('resparkableGoal')).toMatchObject({ userId: OWNER });

    await findBoardsPinningTasks(OWNER, ['t_1']);
    expect(lastWhere('resparkableBoardCard')).toMatchObject({ userId: OWNER });

    await findFilterBoards(OWNER);
    // A cascade only ever runs inside one brain. Without this, a task in one
    // person's brain could be joined to a board in another's.
    expect(lastWhere('resparkableBoard')).toEqual({ userId: OWNER, membership: 'filter' });
  });

  it('reads only filter-backed boards, since explicit ones are covered by their cards', async () => {
    await findFilterBoards(OWNER);
    expect(lastWhere('resparkableBoard')).toHaveProperty('membership', 'filter');
  });
});

describe('share links are looked up by digest', () => {
  it('never queries the plaintext token', async () => {
    const token = 'a-token-that-must-not-appear-in-a-query';

    await findLiveShareLinkByTokenHash(hashShareToken(token));

    const [args] = prismaMock.resparkableShareLink.findUnique.mock.calls[0] as [
      { where: { tokenHash: string } },
    ];

    expect(args.where.tokenHash).toBe(hashShareToken(token));
    expect(args.where.tokenHash).not.toBe(token);
    // 64 hex characters. The point of the deviation from the plaintext-cuid
    // precedent: a database dump hands over no working links.
    expect(args.where.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for an unknown digest', async () => {
    prismaMock.resparkableShareLink.findUnique.mockResolvedValue(null);
    await expect(findLiveShareLinkByTokenHash('deadbeef')).resolves.toBeNull();
  });

  it('returns null for a revoked link, and for an expired one, identically', async () => {
    // §16.4: tampered, revoked and expired must be indistinguishable from
    // outside, or the 404 becomes an oracle telling a stranger which tokens
    // once existed.
    const base = {
      id: 'link_1',
      userId: OWNER,
      entityType: 'project',
      entityId: 'p_1',
      includeChildren: false,
      includeTaskDetail: false,
    };

    prismaMock.resparkableShareLink.findUnique.mockResolvedValue({
      ...base,
      revokedAt: new Date('2026-08-01T00:00:00Z'),
      expiresAt: null,
    });
    const revoked = await findLiveShareLinkByTokenHash('x');

    prismaMock.resparkableShareLink.findUnique.mockResolvedValue({
      ...base,
      revokedAt: null,
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    });
    const expired = await findLiveShareLinkByTokenHash('x', new Date('2026-08-26T00:00:00Z'));

    prismaMock.resparkableShareLink.findUnique.mockResolvedValue(null);
    const unknown = await findLiveShareLinkByTokenHash('x');

    expect(revoked).toBeNull();
    expect(expired).toBeNull();
    expect(unknown).toBeNull();
  });

  it('returns null for a link pointing at a type that is no longer shareable', async () => {
    // Defence against a row written before a type left the list — the resolver
    // must not be handed a `thought` to serve publicly because an old row says so.
    prismaMock.resparkableShareLink.findUnique.mockResolvedValue({
      id: 'link_1',
      userId: OWNER,
      entityType: 'thought',
      entityId: 't_1',
      includeChildren: false,
      includeTaskDetail: false,
      revokedAt: null,
      expiresAt: null,
    });

    await expect(findLiveShareLinkByTokenHash('x')).resolves.toBeNull();
  });
});
