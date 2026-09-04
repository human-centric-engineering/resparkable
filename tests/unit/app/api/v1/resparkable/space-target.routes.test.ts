/**
 * Unit Tests: a route resolving its workspace from the URL (phase 47).
 *
 * Fifty route files stopped minting their own scope in this phase and now open
 * with `requestSpaceScope(request, session.user.id)`. That is one edit repeated
 * fifty times, so it is worth asserting once, end to end, against a real route
 * with real membership resolution underneath rather than a mocked resolver:
 *
 *   1. **No `?space=` still means the personal space**, and costs no membership
 *      read. Almost every request in the product is this one, and if it queried
 *      for a group it would tax every page with a feature its user may not use.
 *   2. **`?space=<group>` reaches the service as the GROUP's space id**, not the
 *      actor's. The partition key travelling instead of the person is the whole
 *      of phase 45 and the reason a shared workspace is expressible at all.
 *   3. **A non-member asking for the same space gets a 404**, not a 403 and not
 *      an empty list. §16.2: a 403 tells whoever guessed the id that they
 *      guessed right, and an empty 200 tells them the same thing more slowly.
 *   4. **A repeated `?space=` falls back to personal** rather than picking one.
 *
 * `/counts` is the route under test for no reason other than that it is the
 * smallest one with a scope in it. The property is the shared helper's, not
 * this endpoint's.
 *
 * @see lib/framework/resparkable/api/space-request.ts
 * @see tests/unit/lib/framework/resparkable/services/membership.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/framework/resparkable/services/counts', () => ({ buildCounts: vi.fn() }));

// Only the membership READ is mocked. `resolveActiveSpaceScope`, the personal
// short-circuit and the scope mint are the real ones, because those are the
// three things this file is about.
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findMembershipBySpace: vi.fn(),
}));

import { GET } from '@/app/api/v1/resparkable/counts/route';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import { buildCounts } from '@/lib/framework/resparkable/services/counts';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const GROUP_SPACE = 'spc_group_1';

function req(query = '') {
  return {
    url: `http://localhost:3000/api/v1/resparkable/counts${query}`,
    headers: new Headers(),
  } as unknown as Request;
}

function invoke(request: unknown): Promise<Response> {
  return (GET as unknown as (...args: unknown[]) => Promise<Response>)(request, SESSION_A);
}

/** The scope the route handed the service. */
function scopeFromCall(): { spaceId: string; actorUserId: string | null; role: string } {
  return vi.mocked(buildCounts).mock.calls[0]?.[0];
}

function membership(role = 'member', joinedAt: Date | null = new Date('2026-09-01T10:00:00Z')) {
  return {
    id: 'mem_1',
    groupId: 'grp_1',
    userId: 'user_a',
    role,
    invitedByUserId: null,
    joinedAt,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCounts).mockResolvedValue({ inbox: 1, connections: 0, openTasks: 2 });
});

describe('a route resolving its workspace', () => {
  it('uses the personal space when the URL names none, without reading membership', async () => {
    const response = await invoke(req());

    expect(response.status).toBe(200);
    expect(scopeFromCall()).toMatchObject({ spaceId: 'user_a', role: 'owner' });
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });

  it("scopes to the GROUP's space id, and carries the actor and role separately", async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership() as never);

    const response = await invoke(req(`?space=${GROUP_SPACE}`));

    expect(response.status).toBe(200);
    // spaceId is the partition, actorUserId is attribution only. If these two
    // were ever the same value on a group space, every query in the tier would
    // be reading one member's rows.
    expect(scopeFromCall()).toMatchObject({
      spaceId: GROUP_SPACE,
      actorUserId: 'user_a',
      role: 'member',
    });
    expect(findMembershipBySpace).toHaveBeenCalledWith('user_a', GROUP_SPACE);
  });

  it('404s a non-member and runs no query at all', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(null);

    const response = await invoke(req(`?space=${GROUP_SPACE}`));

    expect(response.status).toBe(404);
    // Refused before the service, not filtered inside it. A scope that reached
    // `buildCounts` and returned zeroes would be the same leak wearing a
    // different number.
    expect(buildCounts).not.toHaveBeenCalled();
  });

  it('404s a member whose row is still pending', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership('member', null) as never);

    // Phase 57's request-to-join. Waiting is not being in.
    expect((await invoke(req(`?space=${GROUP_SPACE}`))).status).toBe(404);
  });

  it('says "not found" rather than "not allowed", and names no space', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(null);

    const body = (await (await invoke(req('?space=spc_someone_elses'))).json()) as {
      error: { code: string; message: string };
    };

    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).not.toContain('spc_someone_elses');
  });

  it("resolves the actor's own space id to personal without a membership read", async () => {
    // The switcher builds a link back to Personal, and a personal space's key
    // IS its owner's user id. Sending that through group resolution would 404
    // somebody out of their own brain.
    const response = await invoke(req('?space=user_a'));

    expect(response.status).toBe(200);
    expect(scopeFromCall()).toMatchObject({ spaceId: 'user_a', role: 'owner' });
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });

  it('falls back to personal when the URL names two spaces', async () => {
    const response = await invoke(req(`?space=${GROUP_SPACE}&space=spc_other`));

    expect(response.status).toBe(200);
    expect(scopeFromCall()).toMatchObject({ spaceId: 'user_a' });
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });
});
