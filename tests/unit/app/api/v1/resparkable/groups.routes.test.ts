/**
 * Unit Tests: the seven group routes (Release 9, phase 46).
 *
 * The routes are thin, and the things worth asserting about them are the ones a
 * thin handler gets wrong: the same lens `grants.routes.test.ts` applies to the
 * grants tier.
 *
 * - `not_a_member` is a **404, never a 403**. A 403 confirms the group exists to
 *   somebody who guessed an id, and 404-not-403 on cross-user access is
 *   deliberate throughout this codebase. `not_an_admin` is 403, `last_admin` is
 *   409, `unknown_role` is 400, `no_such_member` is 404.
 * - No address reaches a log line on any route except `GET .../invites`, where
 *   addresses are deliberately in the response body: an admin cannot withdraw an
 *   invitation they cannot see.
 * - The member list is an allowlisted projection, not the row: it strips
 *   everything but `userId`, `role` and `joinedAt`.
 * - The accept route answers 200 with `joined: false` on every failure, never a
 *   4xx, and its wrong-account answer carries a masked address.
 * - Every mutating handler is wrapped in `withAuth`, and every body goes through
 *   its Zod schema before a service is ever called.
 * - The last member leaving reports `groupDeleted: true`, so the client knows the
 *   workspace is gone rather than rendering a member list for one.
 *
 * Service decisions (the last-admin rules, scope resolution, token semantics)
 * are covered by `services/membership.test.ts` and `services/group-invites.test.ts`
 * and are not re-tested here. Only the HTTP layer is.
 *
 * @see app/api/v1/resparkable/groups/route.ts
 * @see app/api/v1/resparkable/groups/[id]/route.ts
 * @see app/api/v1/resparkable/groups/[id]/members/route.ts
 * @see app/api/v1/resparkable/groups/[id]/members/[userId]/route.ts
 * @see app/api/v1/resparkable/groups/[id]/invites/route.ts
 * @see app/api/v1/resparkable/groups/[id]/invites/[inviteId]/route.ts
 * @see app/api/v1/resparkable/groups/invites/accept/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const routeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/api/context', () => ({ getRouteLogger: async () => routeLog }));

vi.mock('@/lib/logging', () => ({
  logger: {
    withContext: () => routeLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

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

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  listGroupMembers: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  createGroup: vi.fn(),
  listGroupsForActor: vi.fn(),
  resolveGroupMembership: vi.fn(),
  updateGroupSettings: vi.fn(),
  deleteGroup: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/group-invites', () => ({
  issueGroupInvite: vi.fn(),
  listInvitesForAdmin: vi.fn(),
  revokeGroupInvite: vi.fn(),
  acceptGroupInvite: vi.fn(),
}));

import { GET as GROUPS_GET, POST as GROUPS_POST } from '@/app/api/v1/resparkable/groups/route';
import {
  DELETE as GROUP_DELETE,
  GET as GROUP_GET,
  PATCH as GROUP_PATCH,
} from '@/app/api/v1/resparkable/groups/[id]/route';
import { GET as MEMBERS_GET } from '@/app/api/v1/resparkable/groups/[id]/members/route';
import {
  DELETE as MEMBER_DELETE,
  PATCH as MEMBER_PATCH,
} from '@/app/api/v1/resparkable/groups/[id]/members/[userId]/route';
import {
  GET as INVITES_GET,
  POST as INVITES_POST,
} from '@/app/api/v1/resparkable/groups/[id]/invites/route';
import { DELETE as INVITE_DELETE } from '@/app/api/v1/resparkable/groups/[id]/invites/[inviteId]/route';
import { POST as ACCEPT_POST } from '@/app/api/v1/resparkable/groups/invites/accept/route';
import { listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  changeMemberRole,
  createGroup,
  deleteGroup,
  listGroupsForActor,
  removeMember,
  resolveGroupMembership,
  updateGroupSettings,
} from '@/lib/framework/resparkable/services/membership';
import {
  acceptGroupInvite,
  issueGroupInvite,
  listInvitesForAdmin,
  revokeGroupInvite,
} from '@/lib/framework/resparkable/services/group-invites';

const SESSION = {
  user: { id: 'user_a', email: 'a@example.com' },
  session: { userId: 'user_a' },
};

const GROUP_ID = 'group_1';

const GROUP = {
  id: GROUP_ID,
  name: 'Study Group B',
  slug: 'study-group-b',
  description: 'Weeknight problem sets',
  spaceId: 'spc_abc123',
  maxMembers: 50,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

const MEMBERSHIP = {
  id: 'member_1',
  groupId: GROUP_ID,
  userId: 'user_a',
  role: 'admin',
  invitedByUserId: null,
  joinedAt: new Date('2026-08-01T00:00:00.000Z'),
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  group: GROUP,
};

const SCOPE = spaceScopeFor({ spaceId: 'spc_abc123', actorUserId: 'user_a', role: 'admin' });

function req(url: string, body?: unknown) {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  request: unknown,
  params?: Record<string, string>
): Promise<Response> {
  const fn = handler as (request: unknown, session: unknown, context: unknown) => Promise<Response>;
  return fn(request, SESSION, params ? { params: Promise.resolve(params) } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/resparkable/groups', () => {
  it('creates a group and returns 201', async () => {
    vi.mocked(createGroup).mockResolvedValue(MEMBERSHIP);

    const response = await invoke(
      GROUPS_POST,
      req('http://localhost/api/v1/resparkable/groups', { name: 'Study Group B' })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toEqual({
      groupId: GROUP_ID,
      name: 'Study Group B',
      slug: 'study-group-b',
      spaceId: 'spc_abc123',
      role: 'admin',
    });
  });

  it('rejects a body with no name, rather than reaching the service', async () => {
    const response = await invoke(
      GROUPS_POST,
      req('http://localhost/api/v1/resparkable/groups', { description: 'no name at all' })
    );

    expect(response.status).toBe(400);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('rejects an unknown field on create: a caller-supplied slug or spaceId is not this route’s to accept', async () => {
    const response = await invoke(
      GROUPS_POST,
      req('http://localhost/api/v1/resparkable/groups', {
        name: 'Study Group B',
        spaceId: 'spc_forged',
      })
    );

    expect(response.status).toBe(400);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('never writes the group’s name to a log line', async () => {
    vi.mocked(createGroup).mockResolvedValue(MEMBERSHIP);

    await invoke(
      GROUPS_POST,
      req('http://localhost/api/v1/resparkable/groups', { name: 'Study Group B' })
    );

    // A shared object other people can be identified through, and this line
    // outlives the group.
    expect(JSON.stringify(routeLog.info.mock.calls)).not.toContain('Study Group B');
  });

  it('is wrapped in withAuth: an unexpected service throw becomes an error response, not a rejected promise', async () => {
    vi.mocked(createGroup).mockRejectedValue(new Error('database is on fire'));

    const response = await invoke(
      GROUPS_POST,
      req('http://localhost/api/v1/resparkable/groups', { name: 'Study Group B' })
    );

    expect(response.status).toBe(500);
  });
});

describe('GET /api/v1/resparkable/groups', () => {
  it('lists the caller’s groups as an allowlisted projection, not the row', async () => {
    vi.mocked(listGroupsForActor).mockResolvedValue([MEMBERSHIP]);

    const response = await invoke(GROUPS_GET, req('http://localhost/api/v1/resparkable/groups'));
    const body = await response.json();

    expect(body.meta.count).toBe(1);
    // `MEMBERSHIP` carries `id`, `invitedByUserId`, `createdAt`, `updatedAt` and
    // the group's `maxMembers` too. An exact match proves the route picks seven
    // fields out rather than spreading the membership or the group into the
    // wire shape.
    expect(body.data[0]).toEqual({
      groupId: GROUP_ID,
      name: 'Study Group B',
      slug: 'study-group-b',
      description: 'Weeknight problem sets',
      spaceId: 'spc_abc123',
      role: 'admin',
      joinedAt: MEMBERSHIP.joinedAt.toISOString(),
    });
  });
});

describe('GET /api/v1/resparkable/groups/[id]', () => {
  it('is a 404, not a 403, for a group the caller is not a member of', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );

    // A 403 would confirm the group exists to somebody who guessed an id.
    expect(response.status).toBe(404);
  });

  it('returns the group, the caller’s own role, and a member list with no addresses', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: MEMBERSHIP,
      scope: SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.group).toEqual({
      groupId: GROUP_ID,
      name: 'Study Group B',
      slug: 'study-group-b',
      description: 'Weeknight problem sets',
      spaceId: 'spc_abc123',
      maxMembers: 50,
    });
    expect(body.data.yourRole).toBe('admin');
    // The membership row carries `id`, `groupId`, `invitedByUserId`, `createdAt`,
    // `updatedAt` and the nested `group` besides. An exact match proves the
    // three-field projection, which is what stands between a member list and an
    // address leak the day this row is ever joined against `User`.
    expect(body.data.members).toEqual([
      { userId: 'user_a', role: 'admin', joinedAt: MEMBERSHIP.joinedAt.toISOString() },
    ]);
  });
});

describe('PATCH /api/v1/resparkable/groups/[id]', () => {
  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(updateGroupSettings).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, { name: 'New Name' }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(updateGroupSettings).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, { name: 'New Name' }),
      { id: GROUP_ID }
    );

    // The caller already knows the group exists, because they are in it, so
    // "you are not an admin" is a sentence the UI has to be able to show.
    expect(response.status).toBe(403);
  });

  it('applies a successful update and reports the group id', async () => {
    vi.mocked(updateGroupSettings).mockResolvedValue({ ok: true, value: GROUP });

    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, { name: 'New Name' }),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID });
  });

  it('rejects a `slug` field, rather than reaching the service: re-slugging is not an edit', async () => {
    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, { slug: 'new-slug' }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(updateGroupSettings).not.toHaveBeenCalled();
  });

  it('rejects a maxMembers past the ceiling, rather than reaching the service', async () => {
    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, { maxMembers: 5000 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(updateGroupSettings).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]', () => {
  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(deleteGroup).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      GROUP_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(deleteGroup).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      GROUP_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(403);
  });

  it('deletes on a successful admin call and reports it', async () => {
    vi.mocked(deleteGroup).mockResolvedValue({ ok: true, value: null });

    const response = await invoke(
      GROUP_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID, deleted: true });
  });
});

describe('GET /api/v1/resparkable/groups/[id]/members', () => {
  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    const response = await invoke(
      MEMBERS_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('lists members as userId, role and joinedAt, no addresses', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: MEMBERSHIP,
      scope: SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP]);

    const response = await invoke(
      MEMBERS_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.meta.count).toBe(1);
    // Same projection as the embedded list on `GET /groups/[id]`, asserted here
    // too because this route reads `listGroupMembers` and does its own mapping.
    // A divergence between the two is exactly the kind of thing a shared helper
    // would prevent and this route does not use one.
    expect(body.data).toEqual([
      { userId: 'user_a', role: 'admin', joinedAt: MEMBERSHIP.joinedAt.toISOString() },
    ]);
  });
});

describe('PATCH /api/v1/resparkable/groups/[id]/members/[userId]', () => {
  it('rejects a body with no role, rather than reaching the service', async () => {
    const response = await invoke(
      MEMBER_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`, {}),
      { id: GROUP_ID, userId: 'user_b' }
    );

    expect(response.status).toBe(400);
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  it('rejects a role the schema does not know, rather than reaching the service', async () => {
    const response = await invoke(
      MEMBER_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`, {
        role: 'owner',
      }),
      { id: GROUP_ID, userId: 'user_b' }
    );

    // `owner` is a `SpaceRole`, deliberately not a `GroupRole` (§23.2): a group
    // space has no sole human owner.
    expect(response.status).toBe(400);
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<{ reason: string; status: number }> = [
    { reason: 'not_a_member', status: 404 },
    { reason: 'not_an_admin', status: 403 },
    { reason: 'no_such_member', status: 404 },
    { reason: 'last_admin', status: 409 },
    { reason: 'unknown_role', status: 400 },
  ];

  for (const { reason, status } of REFUSALS) {
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(changeMemberRole).mockResolvedValue({ ok: false, reason: reason as never });

      const response = await invoke(
        MEMBER_PATCH,
        req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`, {
          role: 'viewer',
        }),
        { id: GROUP_ID, userId: 'user_b' }
      );

      expect(response.status).toBe(status);
    });
  }

  it('reports the role on a successful change', async () => {
    vi.mocked(changeMemberRole).mockResolvedValue({ ok: true, value: null });

    const response = await invoke(
      MEMBER_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`, {
        role: 'viewer',
      }),
      { id: GROUP_ID, userId: 'user_b' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID, role: 'viewer' });
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]/members/[userId]', () => {
  const REFUSALS: Array<{ reason: string; status: number }> = [
    { reason: 'not_a_member', status: 404 },
    { reason: 'not_an_admin', status: 403 },
    { reason: 'no_such_member', status: 404 },
    { reason: 'last_admin', status: 409 },
  ];

  for (const { reason, status } of REFUSALS) {
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(removeMember).mockResolvedValue({ ok: false, reason: reason as never });

      const response = await invoke(
        MEMBER_DELETE,
        req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`),
        { id: GROUP_ID, userId: 'user_b' }
      );

      expect(response.status).toBe(status);
    });
  }

  it('reports groupDeleted: false when another member remains', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: true, value: { groupDeleted: false } });

    const response = await invoke(
      MEMBER_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`),
      { id: GROUP_ID, userId: 'user_b' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID, groupDeleted: false });
  });

  it('reports groupDeleted: true when the last member leaves, so the client knows the workspace is gone', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: true, value: { groupDeleted: true } });

    const response = await invoke(
      MEMBER_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_a`),
      { id: GROUP_ID, userId: 'user_a' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID, groupDeleted: true });
  });

  it('is wrapped in withAuth: an unexpected service throw becomes an error response, not a rejected promise', async () => {
    vi.mocked(removeMember).mockRejectedValue(new Error('database is on fire'));

    const response = await invoke(
      MEMBER_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members/user_b`),
      { id: GROUP_ID, userId: 'user_b' }
    );

    expect(response.status).toBe(500);
  });
});

describe('GET /api/v1/resparkable/groups/[id]/invites', () => {
  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(listInvitesForAdmin).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      INVITES_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(listInvitesForAdmin).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      INVITES_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(403);
  });

  it('carries the invited address in the body, unlike the member list, because this one has to', async () => {
    const invite = {
      id: 'invite_1',
      email: 'b@example.com',
      role: 'member',
      invitedAt: new Date('2026-08-15T00:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      acceptedAt: null,
    };
    vi.mocked(listInvitesForAdmin).mockResolvedValue({ ok: true, invites: [invite] });

    const response = await invoke(
      INVITES_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    // An admin who cannot see the address cannot tell what they invited or
    // withdraw it, so this is the one member-adjacent list the route does not
    // strip an address from.
    expect(body.data[0]).toMatchObject({ id: 'invite_1', email: 'b@example.com' });
    expect(body.meta.count).toBe(1);
  });

  it('never writes the invitee’s address to a log line, even while the response body carries it', async () => {
    vi.mocked(listInvitesForAdmin).mockResolvedValue({
      ok: true,
      invites: [
        {
          id: 'invite_1',
          email: 'b@example.com',
          role: 'member',
          invitedAt: new Date(),
          expiresAt: null,
          revokedAt: null,
          acceptedAt: null,
        },
      ],
    });

    await invoke(
      INVITES_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`),
      { id: GROUP_ID }
    );

    expect(JSON.stringify(routeLog.info.mock.calls)).not.toContain('b@example.com');
  });
});

describe('POST /api/v1/resparkable/groups/[id]/invites', () => {
  it('rejects a body with no email, rather than reaching the service', async () => {
    const response = await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, { role: 'member' }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(issueGroupInvite).not.toHaveBeenCalled();
  });

  it('rejects a role of admin: administration is granted to somebody already in the group, not acquired by an address', async () => {
    const response = await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, {
        email: 'b@example.com',
        role: 'admin',
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(issueGroupInvite).not.toHaveBeenCalled();
  });

  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(issueGroupInvite).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, {
        email: 'b@example.com',
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(issueGroupInvite).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, {
        email: 'b@example.com',
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(403);
  });

  it('issues an invite and returns 201', async () => {
    vi.mocked(issueGroupInvite).mockResolvedValue({ ok: true, inviteId: 'invite_1', sent: true });

    const response = await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, {
        email: 'b@example.com',
      }),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toEqual({ inviteId: 'invite_1', sent: true });
  });

  it('never writes the invitee’s address to a log line', async () => {
    vi.mocked(issueGroupInvite).mockResolvedValue({ ok: true, inviteId: 'invite_1', sent: true });

    await invoke(
      INVITES_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites`, {
        email: 'b@example.com',
      }),
      { id: GROUP_ID }
    );

    expect(JSON.stringify(routeLog.info.mock.calls)).not.toContain('b@example.com');
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]/invites/[inviteId]', () => {
  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(revokeGroupInvite).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      INVITE_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites/invite_1`),
      { id: GROUP_ID, inviteId: 'invite_1' }
    );

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(revokeGroupInvite).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      INVITE_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites/invite_1`),
      { id: GROUP_ID, inviteId: 'invite_1' }
    );

    expect(response.status).toBe(403);
  });

  it('withdraws the invite and reports it', async () => {
    vi.mocked(revokeGroupInvite).mockResolvedValue({ ok: true });

    const response = await invoke(
      INVITE_DELETE,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/invites/invite_1`),
      { id: GROUP_ID, inviteId: 'invite_1' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ inviteId: 'invite_1', revoked: true });
  });
});

describe('POST /api/v1/resparkable/groups/invites/accept', () => {
  it('rejects a malformed token, rather than reaching the service', async () => {
    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/groups/invites/accept', { token: 'too-short' })
    );

    expect(response.status).toBe(400);
    expect(acceptGroupInvite).not.toHaveBeenCalled();
  });

  it('answers 200 with joined: true on a successful accept', async () => {
    vi.mocked(acceptGroupInvite).mockResolvedValue({
      ok: true,
      groupId: GROUP_ID,
      groupName: 'Study Group B',
      spaceId: 'spc_abc123',
      alreadyMember: false,
    });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/groups/invites/accept', {
        token: 'a'.repeat(32),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      joined: true,
      groupId: GROUP_ID,
      groupName: 'Study Group B',
      spaceId: 'spc_abc123',
      alreadyMember: false,
    });
  });

  it('answers 200 with joined: false on an unknown token, never a 4xx', async () => {
    vi.mocked(acceptGroupInvite).mockResolvedValue({ ok: false, reason: 'unknown' });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/groups/invites/accept', {
        token: 'a'.repeat(32),
      })
    );
    const body = await response.json();

    // A 4xx here would put an ordinary "this link has expired" into error
    // monitoring alongside real faults.
    expect(response.status).toBe(200);
    expect(body.data).toEqual({ joined: false, reason: 'unknown' });
  });

  it('answers 200 with joined: false and a masked address on the wrong account', async () => {
    vi.mocked(acceptGroupInvite).mockResolvedValue({
      ok: false,
      reason: 'wrong_account',
      expectedEmail: 'a***@e***.com',
    });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/groups/invites/accept', {
        token: 'a'.repeat(32),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      joined: false,
      reason: 'wrong_account',
      expectedEmail: 'a***@e***.com',
    });
    // The route trusts the service's own masking rather than re-deriving it; the
    // one thing worth pinning here is that the address that reaches the wire is
    // the masked one, never the raw one the service also holds.
    expect(JSON.stringify(body)).not.toContain('@example.com');
  });
});
