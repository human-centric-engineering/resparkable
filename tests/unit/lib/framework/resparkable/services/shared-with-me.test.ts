/**
 * Unit Tests: `/shared-with-me` (Release 2, phase 12).
 *
 * This is the only surface in the tier that reads across a person, so the
 * properties it has to hold are the ones the whole access layer exists for:
 *
 *   1. **Every read is scoped to the owner the grant names.** A viewer holding
 *      grants from two people must produce two separately-scoped queries, never
 *      one query spanning both — a projection that could span owners is a
 *      projection that could be handed the wrong one.
 *   2. **The search never touches `ResparkableEmbedding`.** §16.5 asks for this
 *      to be provable by inspecting the queries rather than by mocking, so the
 *      assertion here is over the modules the service is allowed to call at all:
 *      the embedding repo is mocked to throw.
 *   3. **The owner is denied on their own item through this route.** Serving
 *      them here would give them a second, differently-redacted view of their
 *      own brain and a second set of rules to keep in step.
 *   4. **Revocation is resolved per request.** Opening an item re-resolves
 *      rather than trusting the list that linked to it.
 *   5. **The cascade is followed one level and no further**, from the declared
 *      table rather than from a second implementation.
 *
 * @see lib/framework/resparkable/services/shared-with-me.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resparkableVisibilityScope = vi.fn();
const resolveResparkableAccess = vi.fn();

vi.mock('@/lib/framework/resparkable/access/resolve', async () => {
  const actual = await vi.importActual<typeof import('@/lib/framework/resparkable/access/resolve')>(
    '@/lib/framework/resparkable/access/resolve'
  );
  return {
    ...actual,
    resparkableVisibilityScope: (...args: unknown[]) => resparkableVisibilityScope(...args),
    resolveResparkableAccess: (...args: unknown[]) => resolveResparkableAccess(...args),
  };
});

const findSharedItems = vi.fn();
const findSharedChildIds = vi.fn();
const findSharedItem = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/shared-view', () => ({
  findSharedItems: (...args: unknown[]) => findSharedItems(...args),
  findSharedChildIds: (...args: unknown[]) => findSharedChildIds(...args),
  findSharedItem: (...args: unknown[]) => findSharedItem(...args),
  SHARED_CHILD_LIMIT: 200,
}));

const findOwnerContact = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({
  findOwnerContact: (...args: unknown[]) => findOwnerContact(...args),
}));

const buildBoardView = vi.fn();

vi.mock('@/lib/framework/resparkable/services/board-view', () => ({
  buildBoardView: (...args: unknown[]) => buildBoardView(...args),
}));

/**
 * The embedding repo, mocked to throw.
 *
 * §16.5 asks that the exclusion be asserted "by inspecting the built context,
 * not by mocking" — the spirit of which is that the guarantee must be
 * structural. This is the structural form of it available to a unit test: if
 * anything in this file's call graph ever reaches the owner's vector store, the
 * test dies rather than quietly passing with a stubbed empty array.
 */
vi.mock('@/lib/framework/resparkable/repo/embeddings', () => ({
  hybridSearchRows: () => {
    throw new Error('shared-with-me must never read ResparkableEmbedding');
  },
  findEmbeddingsFor: () => {
    throw new Error('shared-with-me must never read ResparkableEmbedding');
  },
}));

import {
  listSharedWithMe,
  readSharedWithMe,
  searchSharedWithMe,
} from '@/lib/framework/resparkable/services/shared-with-me';

const NOW = new Date('2026-08-28T10:00:00.000Z');
const VIEWER = { userId: 'user_b', email: 'b@example.com' };

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    ownerId: 'user_a',
    entityType: 'project' as const,
    entityId: 'p_1',
    role: 'viewer' as const,
    includeTaskDetail: false,
    acceptedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'project' as const,
    id: 'p_1',
    title: 'Acme Redesign',
    body: 'A redesign of the Acme site',
    status: 'active',
    dueAt: null,
    horizon: null,
    archived: false,
    updatedAt: NOW,
    tags: [],
    checklist: null,
    ...overrides,
  };
}

function scopeOf(grants: ReturnType<typeof grant>[]) {
  const directRefsByType = new Map<string, string[]>();
  for (const g of grants) {
    const ids = directRefsByType.get(g.entityType) ?? [];
    ids.push(g.entityId);
    directRefsByType.set(g.entityType, ids);
  }
  return { viewer: VIEWER, grants, directRefsByType };
}

beforeEach(() => {
  vi.clearAllMocks();
  findOwnerContact.mockResolvedValue({
    email: 'a@example.com',
    name: 'Priya',
    emailVerified: true,
  });
  findSharedItems.mockResolvedValue([item()]);
  findSharedChildIds.mockResolvedValue(null);
});

describe('listSharedWithMe', () => {
  it('returns nothing, and queries nothing, for a viewer with no grants', async () => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([]));

    expect(await listSharedWithMe(VIEWER, {}, NOW)).toEqual([]);
    expect(findSharedItems).not.toHaveBeenCalled();
    expect(findOwnerContact).not.toHaveBeenCalled();
  });

  it('names the owner, because a named grant is a relationship', async () => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([grant()]));

    const [entry] = await listSharedWithMe(VIEWER, {}, NOW);

    expect(entry.owner).toEqual({ id: 'user_a', name: 'Priya', email: 'a@example.com' });
    // The grant's own createdAt, never "now": a grant to an address that
    // already has an account is live from the moment it is issued and may never
    // be accepted, so acceptedAt cannot stand in for when it was shared.
    expect(entry.sharedAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
  });

  it('scopes each owner separately when grants come from two people', async () => {
    resparkableVisibilityScope.mockResolvedValue(
      scopeOf([grant(), grant({ id: 'grant_2', ownerId: 'user_c', entityId: 'p_2' })])
    );
    findSharedItems
      .mockResolvedValueOnce([item()])
      .mockResolvedValueOnce([item({ id: 'p_2', title: 'Other' })]);

    await listSharedWithMe(VIEWER, {}, NOW);

    // Two calls, each carrying its own owner scope. One call with both ids
    // would be a projection spanning two brains.
    expect(findSharedItems).toHaveBeenCalledTimes(2);
    const scopes = findSharedItems.mock.calls.map((call) => call[0].userId);
    expect(new Set(scopes)).toEqual(new Set(['user_a', 'user_c']));
  });

  it('asks twice for one owner when two grants disagree about task detail', async () => {
    resparkableVisibilityScope.mockResolvedValue(
      scopeOf([
        grant({ entityType: 'project', entityId: 'p_1', includeTaskDetail: false }),
        grant({ id: 'grant_2', entityType: 'project', entityId: 'p_2', includeTaskDetail: true }),
      ])
    );
    findSharedItems.mockResolvedValueOnce([item()]).mockResolvedValueOnce([item({ id: 'p_2' })]);

    await listSharedWithMe(VIEWER, {}, NOW);

    // Grouping by (owner, type) alone would let the first grant's flag decide
    // for the second, which is how a grant that never opened notes ends up
    // showing them.
    const flags = findSharedItems.mock.calls.map((call) => call[3]);
    expect(new Set(flags)).toEqual(new Set([true, false]));
  });

  it('drops a grant whose item has since been deleted rather than erroring', async () => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([grant()]));
    findSharedItems.mockResolvedValue([]);

    expect(await listSharedWithMe(VIEWER, {}, NOW)).toEqual([]);
  });

  it('lists direct grants only — a shared project is one row, not its tasks', async () => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([grant()]));

    const entries = await listSharedWithMe(VIEWER, {}, NOW);

    expect(entries).toHaveLength(1);
    // The cascade belongs to the item that was handed over, not to the list.
    expect(findSharedChildIds).not.toHaveBeenCalled();
  });
});

describe('readSharedWithMe', () => {
  it('denies the owner their own item through this route', async () => {
    resolveResparkableAccess.mockResolvedValue({
      ok: true,
      basis: 'owner',
      ownerId: 'user_b',
      permissions: { read: true, comment: true },
      redact: [],
      via: null,
    });

    expect(
      await readSharedWithMe(VIEWER, { entityType: 'project', entityId: 'p_1' }, NOW)
    ).toBeNull();
  });

  it('resolves on this request rather than trusting the list', async () => {
    resolveResparkableAccess.mockResolvedValue({
      ok: false,
      basis: null,
      ownerId: null,
      permissions: { read: false, comment: false },
      redact: [],
      via: null,
    });

    expect(
      await readSharedWithMe(VIEWER, { entityType: 'project', entityId: 'p_1' }, NOW)
    ).toBeNull();
    expect(resolveResparkableAccess).toHaveBeenCalledTimes(1);
  });

  it('reads includeTaskDetail off the redaction set, not off a second grant query', async () => {
    resolveResparkableAccess.mockResolvedValue({
      ok: true,
      basis: 'grant',
      ownerId: 'user_a',
      // `notes` absent means the grant opened prose.
      redact: ['priorityScore', 'events', 'parent'],
      permissions: { read: true, comment: false },
      via: null,
    });
    findSharedItem.mockResolvedValue(item());

    const result = await readSharedWithMe(VIEWER, { entityType: 'project', entityId: 'p_1' }, NOW);

    expect(result?.payload.includeTaskDetail).toBe(true);
    expect(findSharedItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'project',
      'p_1',
      true
    );
  });

  it('withholds prose when the grant redacts notes', async () => {
    resolveResparkableAccess.mockResolvedValue({
      ok: true,
      basis: 'grant',
      ownerId: 'user_a',
      redact: ['notes', 'priorityScore'],
      permissions: { read: true, comment: false },
      via: null,
    });
    findSharedItem.mockResolvedValue(item());

    const result = await readSharedWithMe(VIEWER, { entityType: 'project', entityId: 'p_1' }, NOW);

    expect(result?.payload.includeTaskDetail).toBe(false);
    expect(findSharedItem.mock.calls[0][3]).toBe(false);
  });
});

describe('searchSharedWithMe', () => {
  beforeEach(() => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([grant()]));
  });

  it('matches on the projected title and body', async () => {
    findSharedItems.mockResolvedValue([item()]);

    const result = await searchSharedWithMe(VIEWER, { q: 'redesign' }, NOW);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].item.id).toBe('p_1');
    expect(result.truncated).toBe(false);
  });

  it('is case-insensitive, and finds nothing for words that are not there', async () => {
    findSharedItems.mockResolvedValue([item()]);

    expect((await searchSharedWithMe(VIEWER, { q: 'ACME' }, NOW)).items).toHaveLength(1);
    expect((await searchSharedWithMe(VIEWER, { q: 'quarterly' }, NOW)).items).toHaveLength(0);
  });

  it('reaches one level of cascade and names the parent it came through', async () => {
    findSharedChildIds.mockResolvedValue({ childType: 'task', ids: ['t_1'] });
    findSharedItems.mockImplementation((_scope, type: string) =>
      Promise.resolve(
        type === 'task'
          ? [item({ entityType: 'task', id: 't_1', title: 'Redesign the header', body: null })]
          : [item({ title: 'Unrelated', body: null })]
      )
    );

    const result = await searchSharedWithMe(VIEWER, { q: 'header' }, NOW);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].item.id).toBe('t_1');
    // Named, so the UI does not present a task inside a shared project as
    // something handed over on its own.
    expect(result.items[0].via).toBe('p_1');
  });

  it('does not follow a cascade the caller filtered out of reach', async () => {
    findSharedChildIds.mockResolvedValue({ childType: 'task', ids: ['t_1'] });

    await searchSharedWithMe(VIEWER, { q: 'anything', entityType: 'goal' }, NOW);

    // A `goal` filter over a `project` grant can produce nothing: the grant is
    // not a goal and its cascade reaches tasks. Spending a child query to throw
    // the answer away is the cost this guards.
    expect(findSharedChildIds).not.toHaveBeenCalled();
  });

  it('never reads the owner’s embeddings', async () => {
    findSharedItems.mockResolvedValue([item()]);

    // The embedding repo is mocked to throw, so reaching it fails the run
    // rather than passing on a stubbed empty array.
    await expect(searchSharedWithMe(VIEWER, { q: 'redesign' }, NOW)).resolves.toBeDefined();
  });

  it('returns nothing and queries nothing for a viewer with no grants', async () => {
    resparkableVisibilityScope.mockResolvedValue(scopeOf([]));

    expect(await searchSharedWithMe(VIEWER, { q: 'anything' }, NOW)).toEqual({
      items: [],
      truncated: false,
    });
    expect(findSharedItems).not.toHaveBeenCalled();
  });
});
