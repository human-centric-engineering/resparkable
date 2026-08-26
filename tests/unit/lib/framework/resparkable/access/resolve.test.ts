/**
 * Unit Tests: access resolution (Release 2, phase 10).
 *
 * This is the sharing layer's isolation suite, and it is the most important
 * file in the release. Everything §13 promises reduces to one question asked
 * many times — **may this viewer see this row?** — and every wrong answer is a
 * leak, not a bug report.
 *
 * ## What is mocked, and what deliberately is not
 *
 * Only `store.ts` — the single module in the directory that touches Prisma.
 * `resolve.ts` and `cascade.ts` run for real, because the decisions live there:
 * which query runs at all, in what order, what a basis permits, and what the
 * cascade reaches. Mocking the cascade would leave the suite asserting that a
 * mock returned what it was told to, which is the failure mode
 * `.context/testing/` names as the green bar.
 *
 * The complementary suite is `isolation.test.ts` next door, which asserts the
 * *shape of the SQL* — that no query here can be written without a grantee
 * predicate. Behaviour and shape are different failures and they are tested
 * separately.
 *
 * Test Coverage (plan §16, isolation tests 1–4):
 * - The owner short-circuit fires before any grant or link query runs
 * - `visibility` is never consulted on an owner read
 * - A stranger gets DENY, and DENY discloses no owner id
 * - not-found and not-yours are literally the same value
 * - A thought is unshareable before a single query runs
 * - Direct grants: role, expiry, revocation, the includeTaskDetail switch
 * - The cascade: project → task, goal → child goal, board → task, area → nothing
 * - A filter board shares tasks created later — the accepted leak, asserted
 * - `need: 'comment'` needs a commenter grant on the item itself
 * - A public link buys nothing on the authenticated path
 * - Batched resolution answers identically to the per-item form
 *
 * @see lib/framework/resparkable/access/resolve.ts
 * @see .context/framework/resparkable/plan.md §13
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findEntityOwner = vi.fn();
const findEntityOwners = vi.fn();
const findLiveGrantsForRefs = vi.fn();
const findLiveGrantsForViewer = vi.fn();
const findLiveShareLinkByTokenHash = vi.fn();
const findGoalParents = vi.fn();
const findTaskFacts = vi.fn();
const findBoardsPinningTasks = vi.fn();
const findFilterBoards = vi.fn();

vi.mock('@/lib/framework/resparkable/access/store', () => ({
  findEntityOwner: (...args: unknown[]) => findEntityOwner(...args),
  findEntityOwners: (...args: unknown[]) => findEntityOwners(...args),
  findLiveGrantsForRefs: (...args: unknown[]) => findLiveGrantsForRefs(...args),
  findLiveGrantsForViewer: (...args: unknown[]) => findLiveGrantsForViewer(...args),
  findLiveShareLinkByTokenHash: (...args: unknown[]) => findLiveShareLinkByTokenHash(...args),
  findGoalParents: (...args: unknown[]) => findGoalParents(...args),
  findTaskFacts: (...args: unknown[]) => findTaskFacts(...args),
  findBoardsPinningTasks: (...args: unknown[]) => findBoardsPinningTasks(...args),
  findFilterBoards: (...args: unknown[]) => findFilterBoards(...args),
}));

import {
  resolveResparkableAccess,
  resolveResparkableAccessMany,
  resolveResparkableShareLink,
  resolveResparkableShareLinkChild,
  resparkableVisibilityScope,
  shareLinkAccess,
} from '@/lib/framework/resparkable/access/resolve';
import type { LiveGrant, LiveShareLink } from '@/lib/framework/resparkable/access/types';

const OWNER = 'user_a';
const GRANTEE = { userId: 'user_b', email: 'b@example.com' };
const STRANGER = { userId: 'user_c', email: 'c@example.com' };
const ANONYMOUS = { userId: null, email: null };
/** Cuid-shaped, so `boardFilterSchema` accepts it where a filter names a project. */
const PROJECT = 'clh0000000000000000000001';

function grant(overrides: Partial<LiveGrant> = {}): LiveGrant {
  return {
    id: 'grant_1',
    ownerId: OWNER,
    entityType: 'project',
    entityId: 'p_1',
    role: 'viewer',
    includeTaskDetail: false,
    acceptedAt: new Date('2026-08-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function link(overrides: Partial<LiveShareLink> = {}): LiveShareLink {
  return {
    id: 'link_1',
    ownerId: OWNER,
    entityType: 'project',
    entityId: 'p_1',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findEntityOwner.mockResolvedValue(OWNER);
  findEntityOwners.mockResolvedValue(new Map());
  findLiveGrantsForRefs.mockResolvedValue([]);
  findLiveGrantsForViewer.mockResolvedValue([]);
  findLiveShareLinkByTokenHash.mockResolvedValue(null);
  findGoalParents.mockResolvedValue(new Map());
  findTaskFacts.mockResolvedValue(new Map());
  findBoardsPinningTasks.mockResolvedValue(new Map());
  findFilterBoards.mockResolvedValue([]);
});

describe('the owner short-circuit', () => {
  it('answers from one lookup — no grant query, no link query, no cascade', async () => {
    const result = await resolveResparkableAccess({
      viewer: { userId: OWNER, email: 'a@example.com' },
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result).toEqual({
      ok: true,
      basis: 'owner',
      ownerId: OWNER,
      permissions: { read: true, comment: true },
      redact: [],
      via: null,
    });
    // The whole point of the short circuit: reading your own brain must not
    // cost a join. This is the hot path of a product whose job is to be faster
    // than thinking.
    expect(findLiveGrantsForRefs).not.toHaveBeenCalled();
    expect(findTaskFacts).not.toHaveBeenCalled();
    expect(findEntityOwner).toHaveBeenCalledTimes(1);
  });

  it('redacts nothing from the owner', async () => {
    // There is nothing to hide from yourself. `visibility` is only ever about
    // the public-link surface, never a filter on an owner read — the owner's
    // own agent sees all of the owner's items regardless of it.
    const result = await resolveResparkableAccess({
      viewer: { userId: OWNER, email: null },
      entityType: 'review',
      entityId: 'r_1',
    });

    expect(result.redact).toEqual([]);
    expect(result.permissions).toEqual({ read: true, comment: true });
  });

  it('cannot be reached by an anonymous viewer, whatever the row says', async () => {
    // A null viewer id must never compare equal to a null-ish owner. The owner
    // column is non-null in this schema, but the guard is cheap and the failure
    // it prevents is total.
    findEntityOwner.mockResolvedValue(OWNER);

    const result = await resolveResparkableAccess({
      viewer: ANONYMOUS,
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result.ok).toBe(false);
    expect(result.basis).toBeNull();
  });
});

describe('denial discloses nothing', () => {
  it('gives a stranger and a missing row the SAME value', async () => {
    // §16.2: B GETs A's project → 404, not 403. Returning the owner id on a
    // denial would be a user-enumeration vector, and telling the two apart
    // would confirm that a row exists.
    const strangerOnRealRow = await resolveResparkableAccess({
      viewer: STRANGER,
      entityType: 'project',
      entityId: 'p_1',
    });

    findEntityOwner.mockResolvedValue(null);
    const missingRow = await resolveResparkableAccess({
      viewer: STRANGER,
      entityType: 'project',
      entityId: 'p_nope',
    });

    expect(strangerOnRealRow).toEqual(missingRow);
    expect(strangerOnRealRow.ownerId).toBeNull();
  });

  it('refuses a thought before a single query runs', async () => {
    // The raw capture inbox is unshareable by construction, not by a missing
    // grant. Promote it to a task first — which is the workflow anyway.
    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'thought',
      entityId: 't_1',
    });

    expect(result.ok).toBe(false);
    expect(findEntityOwner).not.toHaveBeenCalled();
    expect(findLiveGrantsForRefs).not.toHaveBeenCalled();
  });

  it('refuses an unknown entity type the same way', async () => {
    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'not_a_type',
      entityId: 'x_1',
    });

    expect(result.ok).toBe(false);
    expect(findEntityOwner).not.toHaveBeenCalled();
  });
});

describe('direct grants', () => {
  it('grants read and withholds the owner-only fields', async () => {
    findLiveGrantsForRefs.mockResolvedValue([grant()]);

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result.basis).toBe('grant');
    expect(result.ownerId).toBe(OWNER);
    expect(result.permissions).toEqual({ read: true, comment: false });
    // A named grant is a relationship: the grantee learns who shared it and can
    // see the conversation on it. Everything the owner uses to run their own
    // life — scores, boost rationales, event history, the parent it hangs off —
    // stays hidden.
    expect(result.redact).not.toContain('ownerIdentity');
    expect(result.redact).not.toContain('comments');
    expect(result.redact).toContain('notes');
    expect(result.redact).toContain('priorityScore');
    expect(result.redact).toContain('manualBoostReason');
    expect(result.redact).toContain('links');
    expect(result.redact).toContain('events');
    expect(result.redact).toContain('parent');
  });

  it('opens notes only when the grant says so', async () => {
    findLiveGrantsForRefs.mockResolvedValue([grant({ includeTaskDetail: true })]);

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result.redact).not.toContain('notes');
    // Opening notes opens notes. It does not open the score.
    expect(result.redact).toContain('priorityScore');
  });

  it('lets a commenter comment and a viewer not', async () => {
    findLiveGrantsForRefs.mockResolvedValue([grant({ role: 'commenter' })]);
    const commenter = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
      need: 'comment',
    });
    expect(commenter.ok).toBe(true);
    expect(commenter.permissions.comment).toBe(true);

    findLiveGrantsForRefs.mockResolvedValue([grant({ role: 'viewer' })]);
    const viewer = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
      need: 'comment',
    });
    expect(viewer.ok).toBe(false);
  });

  it('picks the stronger grant when a viewer matches by both id and email', async () => {
    // The mid-acceptance state: the grant carries the address AND has just been
    // bound to the account. Accepting an invite must not briefly REDUCE what
    // someone can do.
    findLiveGrantsForRefs.mockResolvedValue([
      grant({ id: 'by_email', role: 'viewer' }),
      grant({ id: 'by_id', role: 'commenter', includeTaskDetail: true }),
    ]);

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
      need: 'comment',
    });

    expect(result.ok).toBe(true);
    expect(result.redact).not.toContain('notes');
  });
});

describe('the cascade', () => {
  it('reaches a task through its project', async () => {
    findTaskFacts.mockResolvedValue(
      new Map([['t_1', { id: 't_1', projectId: 'p_1', status: 'todo' }]])
    );
    findLiveGrantsForRefs.mockImplementation(
      async (_viewer, refs: Array<{ entityType: string }>) =>
        refs.some((ref) => ref.entityType === 'project') ? [grant()] : []
    );

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'task',
      entityId: 't_1',
    });

    expect(result.basis).toBe('grant-cascade');
    // The UI needs this to say "shared as part of Acme Redesign" rather than
    // implying the card was handed over on its own.
    expect(result.via).toEqual({ entityType: 'project', entityId: 'p_1' });
  });

  it('reaches a child goal through its parent goal, one level only', async () => {
    findGoalParents.mockResolvedValue(new Map([['g_child', 'g_parent']]));
    findLiveGrantsForRefs.mockImplementation(async (_viewer, refs: Array<{ entityId: string }>) =>
      refs.some((ref) => ref.entityId === 'g_parent')
        ? [grant({ entityType: 'goal', entityId: 'g_parent' })]
        : []
    );

    const child = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'goal',
      entityId: 'g_child',
    });
    expect(child.basis).toBe('grant-cascade');

    // A grandchild is NOT reached. Sharing "Health" says something about
    // Health, not about every goal anyone ever files beneath it at any depth.
    findGoalParents.mockResolvedValue(new Map([['g_grandchild', 'g_child']]));
    const grandchild = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'goal',
      entityId: 'g_grandchild',
    });
    expect(grandchild.ok).toBe(false);
  });

  it('does not cascade from an area to anything', async () => {
    // Explicitly nothing: an area is a life domain, and sharing "Health" must
    // not hand over every project, task and review filed under it.
    findLiveGrantsForRefs.mockResolvedValue([]);

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result.ok).toBe(false);
    // A project has no parent type at all, so the cascade queries are skipped
    // rather than run and discarded.
    expect(findTaskFacts).not.toHaveBeenCalled();
    expect(findGoalParents).not.toHaveBeenCalled();
  });

  it('refuses to comment on a cascaded item even with a commenter grant on the parent', async () => {
    // A cascaded item was never chosen for sharing by its owner. Commenting is
    // something you do to the thing that was actually handed over.
    findTaskFacts.mockResolvedValue(
      new Map([['t_1', { id: 't_1', projectId: 'p_1', status: 'todo' }]])
    );
    // The commenter grant is on the PROJECT. There is none on the task itself.
    findLiveGrantsForRefs.mockImplementation(
      async (_viewer, refs: Array<{ entityType: string }>) =>
        refs.some((ref) => ref.entityType === 'project') ? [grant({ role: 'commenter' })] : []
    );

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'task',
      entityId: 't_1',
      need: 'comment',
    });

    expect(result.ok).toBe(false);
  });
});

describe('the dynamic-filter trap, asserted rather than hidden', () => {
  it('a filter board reaches a task created after the share', async () => {
    // §17 risk 6b, and the leak §13 deliberately ACCEPTS: a board with
    // `membership: 'filter'` is a live query, so sharing it shares every task
    // matching the filter — including ones that do not exist yet. Asserted here
    // so it can never become an accident. The mitigation is in the share dialog
    // (state the filter, show a live count, offer a snapshot), not in silently
    // narrowing what the board means.
    findTaskFacts.mockResolvedValue(
      new Map([['t_new', { id: 't_new', projectId: PROJECT, status: 'todo' }]])
    );
    // A cuid, because `boardFilterSchema` validates it as one and an
    // unparseable filter now denies (see `boardFilterMatches`) — a short
    // fixture id would make this pass for the wrong reason, or not at all.
    findFilterBoards.mockResolvedValue([
      { id: 'b_1', filter: { projectId: PROJECT }, columns: [{ status: 'todo', label: 'Todo' }] },
    ]);
    findLiveGrantsForRefs.mockImplementation(
      async (_viewer, refs: Array<{ entityType: string }>) =>
        refs.some((ref) => ref.entityType === 'board')
          ? [grant({ entityType: 'board', entityId: 'b_1' })]
          : []
    );

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'task',
      entityId: 't_new',
    });

    expect(result.basis).toBe('grant-cascade');
    expect(result.via).toEqual({ entityType: 'board', entityId: 'b_1' });
  });

  it('a snapshot board does NOT do this', async () => {
    // The safer path the dialog offers: flipping to explicit membership
    // materialises today's matches, so a task added afterwards is not on it.
    // `findFilterBoards` returns nothing for an explicit board, and the new
    // task has no card.
    findTaskFacts.mockResolvedValue(
      new Map([['t_new', { id: 't_new', projectId: 'p_1', status: 'todo' }]])
    );
    findFilterBoards.mockResolvedValue([]);
    findBoardsPinningTasks.mockResolvedValue(new Map());
    findLiveGrantsForRefs.mockResolvedValue([]);

    const result = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'task',
      entityId: 't_new',
    });

    expect(result.ok).toBe(false);
  });
});

describe('a public link buys nothing on the authenticated path', () => {
  it('resolveResparkableAccess never consults a share link', async () => {
    // §16.4. Structural rather than remembered: `ResparkableViewer` has no
    // token field, so there is nothing for this function to consult.
    findLiveShareLinkByTokenHash.mockResolvedValue(link());

    const result = await resolveResparkableAccess({
      viewer: STRANGER,
      entityType: 'project',
      entityId: 'p_1',
    });

    expect(result.ok).toBe(false);
    expect(findLiveShareLinkByTokenHash).not.toHaveBeenCalled();
  });

  it('a link grants read of exactly one item, and no comment', async () => {
    const result = shareLinkAccess(link());

    expect(result.basis).toBe('link');
    expect(result.permissions).toEqual({ read: true, comment: false });
    // A public link is a document, not a relationship: the reader learns
    // nothing about the person who wrote it.
    expect(result.redact).toContain('ownerIdentity');
    expect(result.redact).toContain('comments');
  });

  it('refuses a child when includeChildren is off, without a query', async () => {
    const result = await resolveResparkableShareLinkChild(link({ includeChildren: false }), {
      entityType: 'task',
      entityId: 't_1',
    });

    expect(result.ok).toBe(false);
    expect(findEntityOwner).not.toHaveBeenCalled();
  });

  it('refuses a child belonging to someone else even when it cascades', async () => {
    // The id comes from a URL, so it is attacker-supplied. "Whose row is this?"
    // is asked before the cascade, not inferred from it.
    findEntityOwner.mockResolvedValue('user_z');

    const result = await resolveResparkableShareLinkChild(link({ includeChildren: true }), {
      entityType: 'task',
      entityId: 't_1',
    });

    expect(result.ok).toBe(false);
  });

  it('reaches a child that genuinely cascades from the linked item', async () => {
    findEntityOwner.mockResolvedValue(OWNER);
    findTaskFacts.mockResolvedValue(
      new Map([['t_1', { id: 't_1', projectId: 'p_1', status: 'todo' }]])
    );

    const result = await resolveResparkableShareLinkChild(link({ includeChildren: true }), {
      entityType: 'task',
      entityId: 't_1',
    });

    expect(result.basis).toBe('link-cascade');
    expect(result.via).toEqual({ entityType: 'project', entityId: 'p_1' });
  });

  it('treats a blank token as no token, without a lookup', async () => {
    await expect(resolveResparkableShareLink('')).resolves.toBeNull();
    expect(findLiveShareLinkByTokenHash).not.toHaveBeenCalled();
  });
});

describe('the batched form', () => {
  it('resolves owners in one query per type, not one per row', async () => {
    findEntityOwners.mockImplementation(async (type: string, ids: string[]) =>
      type === 'task' ? new Map(ids.map((id) => [id, OWNER])) : new Map()
    );

    await resolveResparkableAccessMany({
      viewer: { userId: OWNER, email: null },
      refs: Array.from({ length: 50 }, (_, index) => ({
        entityType: 'task',
        entityId: `t_${index}`,
      })),
    });

    // The cost §13 accepted when it put `task` back on the shareable list: a
    // per-row resolver would make sharing a fifty-card board a two-hundred-query
    // page load.
    expect(findEntityOwners).toHaveBeenCalledTimes(1);
    expect(findLiveGrantsForRefs).not.toHaveBeenCalled();
  });

  it('agrees with the per-item form on every basis', async () => {
    findEntityOwner.mockResolvedValue(OWNER);
    findEntityOwners.mockImplementation(async (type: string, ids: string[]) =>
      type === 'project' ? new Map(ids.map((id) => [id, OWNER])) : new Map()
    );
    findLiveGrantsForRefs.mockResolvedValue([grant()]);

    const single = await resolveResparkableAccess({
      viewer: GRANTEE,
      entityType: 'project',
      entityId: 'p_1',
    });
    const batched = await resolveResparkableAccessMany({
      viewer: GRANTEE,
      refs: [{ entityType: 'project', entityId: 'p_1' }],
    });

    expect(batched.get('project:p_1')).toEqual(single);
  });

  it('denies an id it could not find an owner for', async () => {
    findEntityOwners.mockResolvedValue(new Map());

    const results = await resolveResparkableAccessMany({
      viewer: GRANTEE,
      refs: [{ entityType: 'project', entityId: 'p_gone' }],
    });

    expect(results.get('project:p_gone')?.ok).toBe(false);
  });

  it('drops unshareable types rather than resolving them', async () => {
    const results = await resolveResparkableAccessMany({
      viewer: GRANTEE,
      refs: [{ entityType: 'thought', entityId: 't_1' }],
    });

    expect(results.size).toBe(0);
    expect(findEntityOwners).not.toHaveBeenCalled();
  });

  it('deduplicates repeated refs so one item is queried once', async () => {
    findEntityOwners.mockImplementation(async (_type: string, ids: string[]) => {
      expect(ids).toEqual(['p_1']);
      return new Map(ids.map((id) => [id, OWNER]));
    });

    await resolveResparkableAccessMany({
      viewer: { userId: OWNER, email: null },
      refs: [
        { entityType: 'project', entityId: 'p_1' },
        { entityType: 'project', entityId: 'p_1' },
      ],
    });

    expect(findEntityOwners).toHaveBeenCalledTimes(1);
  });
});

describe('resparkableVisibilityScope', () => {
  it('groups the viewer’s live grants by type', async () => {
    findLiveGrantsForViewer.mockResolvedValue([
      grant({ entityType: 'project', entityId: 'p_1' }),
      grant({ entityType: 'project', entityId: 'p_2' }),
      grant({ entityType: 'board', entityId: 'b_1' }),
    ]);

    const scope = await resparkableVisibilityScope(GRANTEE);

    expect(scope.directRefsByType.get('project')).toEqual(['p_1', 'p_2']);
    expect(scope.directRefsByType.get('board')).toEqual(['b_1']);
    // Shared-in items get their own surface. They do NOT appear in the
    // viewer's own lists or search — which is what preserves
    // `WHERE userId = $1` as an unconditional invariant everywhere else.
    expect(scope.directRefsByType.get('task')).toBeUndefined();
  });

  it('is empty for an anonymous viewer', async () => {
    findLiveGrantsForViewer.mockResolvedValue([]);

    const scope = await resparkableVisibilityScope(ANONYMOUS);

    expect(scope.grants).toEqual([]);
    expect(scope.directRefsByType.size).toBe(0);
  });
});
