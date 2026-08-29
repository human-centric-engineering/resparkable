/**
 * Unit Tests: `listMyShares` — the owner's outbound-share inventory.
 *
 * This surface exists for one reason, so that reason is what the tests are
 * about: **a share must stay closable after its entity stops being reachable.**
 * Before it, `ShareDialog` was only reachable through the entity's own control,
 * and a link on a replaced review or an archived project could not be revoked
 * by anything.
 *
 * The properties worth pinning:
 *
 *   1. **A share whose entity is gone is still a row.** `findSharedItems`
 *      returns nothing for it, and the naive implementation drops it. That row
 *      is the single most important one on the page.
 *   2. **An archived entity keeps its shares, and says so.** Archiving revokes
 *      nothing, which is the surprise this page is meant to surface.
 *   3. **Unreachable sorts first.** Somebody here is closing something, and
 *      the shares with no other route to them must not be below the fold.
 *   4. **Titles are resolved per type, never per share.** One query per
 *      shareable type that has shares, so twenty shares on one project is one
 *      query, not twenty. This is the N+1 `CLAUDE.md` forbids on list
 *      endpoints, and it is the shape this would take by accident.
 *   5. **Grants and links on one entity land on one row**, because "what have
 *      I shared?" is answered per thing rather than per mechanism.
 *   6. **A stored `entityType` outside the six is skipped, not thrown on.** A
 *      page whose job is cleaning up bad state must not be taken down by it.
 *
 * @see lib/framework/resparkable/services/my-shares.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listOwnGrants = vi.fn();
const listOwnShareLinks = vi.fn();
const findSharedItems = vi.fn();

vi.mock('@/lib/framework/resparkable/services/grants', () => ({
  listOwnGrants: (...args: unknown[]) => listOwnGrants(...args),
}));

vi.mock('@/lib/framework/resparkable/services/sharing', () => ({
  listOwnShareLinks: (...args: unknown[]) => listOwnShareLinks(...args),
}));

vi.mock('@/lib/framework/resparkable/repo/shared-view', () => ({
  findSharedItems: (...args: unknown[]) => findSharedItems(...args),
}));

import { listMyShares, summariseShares } from '@/lib/framework/resparkable/services/my-shares';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const scope = ownerScope('user_1');

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    entityType: 'project',
    entityId: 'proj_1',
    granteeEmail: 'friend@example.com',
    role: 'viewer',
    includeTaskDetail: false,
    accepted: true,
    invitedAt: null,
    expiresAt: null,
    revokedAt: null,
    active: true,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    entityType: 'review',
    entityId: 'rev_1',
    tokenPrefix: 'abcd',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    active: true,
    viewCount: 3,
    lastViewedAt: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'project',
    id: 'proj_1',
    title: 'Q4 launch',
    body: null,
    status: 'active',
    dueAt: null,
    horizon: null,
    archived: false,
    updatedAt: new Date('2026-01-01'),
    tags: [],
    checklist: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listOwnGrants.mockResolvedValue([]);
  listOwnShareLinks.mockResolvedValue([]);
  findSharedItems.mockResolvedValue([]);
});

describe('listMyShares', () => {
  it('keeps a share whose entity no longer exists', async () => {
    listOwnShareLinks.mockResolvedValue([link()]);
    // The row is gone, so the resolver has nothing to return for it.
    findSharedItems.mockResolvedValue([]);

    const items = await listMyShares(scope);

    // The row that must not vanish: without it, a live link on a deleted or
    // replaced entity is invisible and therefore permanently unrevocable.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entityType: 'review', entityId: 'rev_1', title: null });
    expect(items[0]?.links).toHaveLength(1);
  });

  it('reports an archived entity as still shared', async () => {
    listOwnGrants.mockResolvedValue([grant()]);
    findSharedItems.mockResolvedValue([view({ archived: true })]);

    const [item] = await listMyShares(scope);

    // Archiving revokes nothing. That is the whole surprise this page exists
    // to surface, so it has to reach the payload rather than being inferred.
    expect(item).toMatchObject({ title: 'Q4 launch', archived: true });
    expect(item?.grants).toHaveLength(1);
  });

  it('sorts gone, then archived, then live', async () => {
    listOwnGrants.mockResolvedValue([
      grant({ id: 'g_live', entityId: 'proj_live' }),
      grant({ id: 'g_gone', entityId: 'proj_gone' }),
      grant({ id: 'g_arch', entityId: 'proj_arch' }),
    ]);
    findSharedItems.mockResolvedValue([
      view({ id: 'proj_live', title: 'Live one' }),
      view({ id: 'proj_arch', title: 'Archived one', archived: true }),
      // `proj_gone` deliberately absent.
    ]);

    const items = await listMyShares(scope);

    expect(items.map((item) => item.entityId)).toEqual(['proj_gone', 'proj_arch', 'proj_live']);
  });

  it('resolves titles once per type, not once per share', async () => {
    // Twenty shares spread over two entities of one type, plus one of another.
    listOwnGrants.mockResolvedValue(
      Array.from({ length: 20 }, (_unused, index) =>
        grant({ id: `g_${index}`, entityId: index % 2 === 0 ? 'proj_1' : 'proj_2' })
      )
    );
    listOwnShareLinks.mockResolvedValue([link()]);
    findSharedItems.mockResolvedValue([]);

    await listMyShares(scope);

    // Two calls: one for `project`, one for `review`. Not twenty-one.
    expect(findSharedItems).toHaveBeenCalledTimes(2);

    const projectCall = findSharedItems.mock.calls.find((call) => call[1] === 'project');
    // Both ids batched into the one call, deduplicated.
    expect([...(projectCall?.[2] as string[])].sort()).toEqual(['proj_1', 'proj_2']);
  });

  it('puts a grant and a link on the same entity into one row', async () => {
    listOwnGrants.mockResolvedValue([grant()]);
    listOwnShareLinks.mockResolvedValue([link({ entityType: 'project', entityId: 'proj_1' })]);
    findSharedItems.mockResolvedValue([view()]);

    const items = await listMyShares(scope);

    // One thing shared two ways is one row. "What have I shared?" is a question
    // about things, not about mechanisms.
    expect(items).toHaveLength(1);
    expect(items[0]?.grants).toHaveLength(1);
    expect(items[0]?.links).toHaveLength(1);
  });

  it('skips a stored entityType outside the six rather than throwing', async () => {
    listOwnGrants.mockResolvedValue([
      grant({ id: 'g_bad', entityType: 'thought', entityId: 'th_1' }),
      grant({ id: 'g_ok' }),
    ]);
    findSharedItems.mockResolvedValue([view()]);

    const items = await listMyShares(scope);

    // One bad row must not take down the page that exists to clean up bad
    // state, and `thought` is deliberately unshareable so such a row is
    // already evidence of something wrong.
    expect(items).toHaveLength(1);
    expect(items[0]?.entityType).toBe('project');
  });

  it('excludes revoked and expired shares unless asked for them', async () => {
    await listMyShares(scope);
    expect(listOwnGrants).toHaveBeenCalledWith(
      scope,
      { includeInactive: false },
      expect.anything()
    );

    vi.clearAllMocks();
    listOwnGrants.mockResolvedValue([]);
    listOwnShareLinks.mockResolvedValue([]);

    await listMyShares(scope, { includeInactive: true });
    expect(listOwnGrants).toHaveBeenCalledWith(scope, { includeInactive: true }, expect.anything());
    expect(listOwnShareLinks).toHaveBeenCalledWith(
      scope,
      { includeInactive: true },
      expect.anything()
    );
  });

  it('issues no title query at all when nothing is shared', async () => {
    const items = await listMyShares(scope);

    expect(items).toEqual([]);
    expect(findSharedItems).not.toHaveBeenCalled();
  });
});

describe('summariseShares', () => {
  it('counts unreachable items, which is the number the page exists for', () => {
    const totals = summariseShares([
      {
        entityType: 'project',
        entityId: 'a',
        title: 'Live',
        archived: false,
        grants: [],
        links: [],
      },
      { entityType: 'project', entityId: 'b', title: 'Old', archived: true, grants: [], links: [] },
      { entityType: 'review', entityId: 'c', title: null, archived: false, grants: [], links: [] },
    ] as never);

    expect(totals.items).toBe(3);
    // Archived and gone both count: both are items the owner cannot open, and
    // therefore shares they had no other route to.
    expect(totals.unreachable).toBe(2);
  });

  it('counts grants and links separately', () => {
    const totals = summariseShares([
      {
        entityType: 'project',
        entityId: 'a',
        title: 'Live',
        archived: false,
        grants: [grant(), grant({ id: 'g2' })],
        links: [link()],
      },
    ] as never);

    expect(totals).toMatchObject({ items: 1, grants: 2, links: 1 });
  });
});
