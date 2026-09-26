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
 *   everything but `userId`, `role`, `joinedAt` and `requestedAt`.
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
  findAccountNames: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/membership', async () => {
  // `permissionsFor` and `visibleMemberRows` are pure rules the routes now
  // call directly (they used to inline `membership.role === 'admin'`), so the
  // real implementations are kept here rather than stubbed: a mock cannot
  // drift from the rule it is supposed to exercise.
  const actual = await vi.importActual<
    typeof import('@/lib/framework/resparkable/services/membership')
  >('@/lib/framework/resparkable/services/membership');
  return {
    ...actual,
    createGroup: vi.fn(),
    listGroupsForActor: vi.fn(),
    resolveGroupMembership: vi.fn(),
    updateGroupSettings: vi.fn(),
    changeMemberRole: vi.fn(),
    removeMember: vi.fn(),
  };
});

vi.mock('@/lib/framework/resparkable/services/group-deletion', () => ({
  deleteGroupConfirmed: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/group-digest', () => ({
  getLatestGroupDigest: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/framework/resparkable/services/group-invites', () => ({
  issueGroupInvite: vi.fn(),
  listInvitesForAdmin: vi.fn(),
  revokeGroupInvite: vi.fn(),
  acceptGroupInvite: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/group-join-links', () => ({
  mintJoinLink: vi.fn(),
  listJoinLinksForAdmin: vi.fn(),
  revokeGroupJoinLink: vi.fn(),
  redeemJoinLinkToken: vi.fn(),
  approveGroupJoinRequest: vi.fn(),
  rejectGroupJoinRequest: vi.fn(),
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
import {
  GET as JOIN_LINKS_GET,
  POST as JOIN_LINKS_POST,
} from '@/app/api/v1/resparkable/groups/[id]/join-links/route';
import { DELETE as JOIN_LINK_DELETE } from '@/app/api/v1/resparkable/groups/[id]/join-links/[linkId]/route';
import {
  DELETE as JOIN_REQUEST_DELETE,
  POST as JOIN_REQUEST_POST,
} from '@/app/api/v1/resparkable/groups/[id]/join-requests/[userId]/route';
import { POST as JOIN_GROUP_POST } from '@/app/api/v1/resparkable/groups/join/route';
import { findAccountNames, listGroupMembers } from '@/lib/framework/resparkable/repo/groups';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  changeMemberRole,
  createGroup,
  listGroupsForActor,
  removeMember,
  resolveGroupMembership,
  updateGroupSettings,
} from '@/lib/framework/resparkable/services/membership';
import { deleteGroupConfirmed } from '@/lib/framework/resparkable/services/group-deletion';
import { getLatestGroupDigest } from '@/lib/framework/resparkable/services/group-digest';
import {
  acceptGroupInvite,
  issueGroupInvite,
  listInvitesForAdmin,
  revokeGroupInvite,
} from '@/lib/framework/resparkable/services/group-invites';
import {
  approveGroupJoinRequest,
  listJoinLinksForAdmin,
  mintJoinLink,
  redeemJoinLinkToken,
  rejectGroupJoinRequest,
  revokeGroupJoinLink,
} from '@/lib/framework/resparkable/services/group-join-links';

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
  viewersCanInheritAdmin: true,
  joinRefusedFullAt: null,
  fundingMode: 'self_funded',
  lowBalanceAlertCredits: null,
  largeRunAlertPercent: null,
  largeRunAlertedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

const MEMBERSHIP = {
  id: 'member_1',
  groupId: GROUP_ID,
  userId: 'user_a',
  role: 'admin',
  invitedByUserId: null,
  soleAdminNotifiedAt: null,
  dailyCreditCap: null,
  joinedAt: new Date('2026-08-01T00:00:00.000Z'),
  requestedAt: null,
  joinLinkId: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  group: GROUP,
};

/** A pending row: asked to join through a `request` link, not yet let in. */
const PENDING_MEMBERSHIP = {
  ...MEMBERSHIP,
  id: 'member_2',
  userId: 'user_p',
  role: 'member',
  joinedAt: null,
  requestedAt: new Date('2026-09-10T00:00:00.000Z'),
};

const SCOPE = spaceScopeFor({ spaceId: 'spc_abc123', actorUserId: 'user_a', role: 'admin' });
// `permissionsFor`/`visibleMemberRows` now decide from `scope.role`, not
// `membership.role`, so a non-admin fixture has to carry a non-admin scope.
const MEMBER_SCOPE = spaceScopeFor({
  spaceId: 'spc_abc123',
  actorUserId: 'user_a',
  role: 'member',
});

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
  // Every pending-row fixture in this file is anonymous unless a test says
  // otherwise, so a test that forgets to stub this does not throw.
  vi.mocked(findAccountNames).mockResolvedValue(new Map());
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
      viewersCanInheritAdmin: true,
      joinRefusedFullAt: null,
    });
    expect(body.data.yourRole).toBe('admin');
    // The membership row carries `id`, `groupId`, `invitedByUserId`, `createdAt`,
    // `updatedAt` and the nested `group` besides. An exact match proves the
    // four-field projection, which is what stands between a member list and an
    // address leak the day this row is ever joined against `User`.
    expect(body.data.members).toEqual([
      {
        userId: 'user_a',
        role: 'admin',
        joinedAt: MEMBERSHIP.joinedAt.toISOString(),
        requestedAt: null,
        name: null,
      },
    ]);
    expect(body.data.latestDigest).toBeNull();
  });

  it('never carries joinLinkId on a member row, even when the underlying row has one', async () => {
    // `joinLinkId` says which link a joiner came in through, an internal
    // fact for the service layer. The wire projection is four fields;
    // a fifth leaking through would be a fact about the group's
    // administration nobody meant to hand every member.
    const viaLink = { ...MEMBERSHIP, joinLinkId: 'link_1' };
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: viaLink, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([viaLink]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.members[0]).not.toHaveProperty('joinLinkId');
  });

  it('carries a non-null joinRefusedFullAt to an admin', async () => {
    const refusedAt = new Date('2026-09-20T00:00:00.000Z');
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: { ...MEMBERSHIP, group: { ...GROUP, joinRefusedFullAt: refusedAt } },
      scope: SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.group.joinRefusedFullAt).toBe(refusedAt.toISOString());
  });

  it('withholds joinRefusedFullAt from a non-admin, even when the group has one', async () => {
    const refusedAt = new Date('2026-09-20T00:00:00.000Z');
    const memberRole = { ...MEMBERSHIP, role: 'member' };
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: { ...memberRole, group: { ...GROUP, joinRefusedFullAt: refusedAt } },
      scope: MEMBER_SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([memberRole]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.group.joinRefusedFullAt).toBeNull();
  });

  it('includes a pending row, with requestedAt, for an admin', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.members).toContainEqual({
      userId: 'user_p',
      role: 'member',
      joinedAt: null,
      requestedAt: PENDING_MEMBERSHIP.requestedAt.toISOString(),
      name: null,
    });
  });

  it('gives an admin the account name of somebody asking to join', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);
    vi.mocked(findAccountNames).mockResolvedValue(new Map([['user_p', 'Pat Rivera']]));

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    const pending = body.data.members.find((m: { userId: string }) => m.userId === 'user_p');
    expect(pending.name).toBe('Pat Rivera');
    // The joined row never carries a name: it is a fact about a request, not
    // about membership.
    const joined = body.data.members.find((m: { userId: string }) => m.userId === 'user_a');
    expect(joined.name).toBeNull();
  });

  it('falls back to null when the account behind a pending row has no name on file', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);
    vi.mocked(findAccountNames).mockResolvedValue(new Map([['user_p', null]]));

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    const pending = body.data.members.find((m: { userId: string }) => m.userId === 'user_p');
    expect(pending.name).toBeNull();
  });

  it('looks up names only for the pending rows it is showing, never for a joined member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);

    await invoke(GROUP_GET, req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`), {
      id: GROUP_ID,
    });

    expect(findAccountNames).toHaveBeenCalledWith(['user_p']);
  });

  it('never looks up a name, and never shows a pending row or a name, for a non-admin', async () => {
    const memberRole = { ...MEMBERSHIP, role: 'member' };
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: memberRole,
      scope: MEMBER_SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([memberRole, PENDING_MEMBERSHIP]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(findAccountNames).toHaveBeenCalledWith([]);
    expect(body.data.members.map((m: { userId: string }) => m.userId)).toEqual(['user_a']);
  });

  it('never lets an email address reach the response, even with a name attached', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);
    vi.mocked(findAccountNames).mockResolvedValue(new Map([['user_p', 'Pat Rivera']]));

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('withholds a pending row from a non-admin', async () => {
    const memberRole = { ...MEMBERSHIP, role: 'member' };
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: memberRole,
      scope: MEMBER_SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([memberRole, PENDING_MEMBERSHIP]);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.members.map((m: { userId: string }) => m.userId)).toEqual(['user_a']);
  });

  it('carries the newest digest, read in the group’s own space', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP]);
    const digest = {
      id: 'review_1',
      title: 'Week of 21 September',
      body: 'Eleven tasks were finished.',
      generatedAt: '2026-09-21T08:00:00.000Z',
    };
    vi.mocked(getLatestGroupDigest).mockResolvedValueOnce(digest);

    const response = await invoke(
      GROUP_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.latestDigest).toEqual(digest);
    expect(getLatestGroupDigest).toHaveBeenCalledWith(SCOPE);
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

  it('passes the succession setting to the service for the session user', async () => {
    vi.mocked(updateGroupSettings).mockResolvedValue({ ok: true, value: GROUP });

    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, {
        viewersCanInheritAdmin: false,
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(200);
    // The service is what checks the caller is an admin, so the actor must be
    // the session's and the body passed through as validated.
    expect(updateGroupSettings).toHaveBeenCalledWith('user_a', GROUP_ID, {
      viewersCanInheritAdmin: false,
    });
  });

  it('rejects a succession setting that is not a boolean', async () => {
    const response = await invoke(
      GROUP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}`, {
        viewersCanInheritAdmin: 'no',
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(updateGroupSettings).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}`;

  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(deleteGroupConfirmed).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(GROUP_DELETE, req(url, { confirmName: 'Study Group B' }), {
      id: GROUP_ID,
    });

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(deleteGroupConfirmed).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(GROUP_DELETE, req(url, { confirmName: 'Study Group B' }), {
      id: GROUP_ID,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a DELETE with no confirmation before reaching the service', async () => {
    // §23.6: the typed confirmation is enforced for every caller, not only the
    // dialog. A bare DELETE from a script must not be a deletion.
    const response = await invoke(GROUP_DELETE, req(url), { id: GROUP_ID });

    expect(response.status).toBe(400);
    expect(deleteGroupConfirmed).not.toHaveBeenCalled();
  });

  it('is a 400 naming the field when the confirmation does not match', async () => {
    vi.mocked(deleteGroupConfirmed).mockResolvedValue({
      ok: false,
      reason: 'confirmation_mismatch',
    });

    const response = await invoke(GROUP_DELETE, req(url, { confirmName: 'study group b' }), {
      id: GROUP_ID,
    });
    const body = await response.json();

    // A 400, not a 403: the caller may do this, they have not said which group.
    expect(response.status).toBe(400);
    expect(body.error.details).toEqual({ confirmName: ['Does not match the group’s name'] });
  });

  it('passes the session user and the typed name to the service, never a body user', async () => {
    vi.mocked(deleteGroupConfirmed).mockResolvedValue({ ok: true, notified: 2, notifyFailed: 0 });

    await invoke(GROUP_DELETE, req(url, { confirmName: 'Study Group B' }), { id: GROUP_ID });

    expect(deleteGroupConfirmed).toHaveBeenCalledWith('user_a', GROUP_ID, 'Study Group B');
  });

  it('reports how many members were told', async () => {
    vi.mocked(deleteGroupConfirmed).mockResolvedValue({ ok: true, notified: 2, notifyFailed: 1 });

    const response = await invoke(GROUP_DELETE, req(url, { confirmName: 'Study Group B' }), {
      id: GROUP_ID,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ groupId: GROUP_ID, deleted: true, notified: 2, notifyFailed: 1 });
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

  it('lists members as userId, role, joinedAt and requestedAt, no addresses', async () => {
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
      {
        userId: 'user_a',
        role: 'admin',
        joinedAt: MEMBERSHIP.joinedAt.toISOString(),
        requestedAt: null,
      },
    ]);
  });

  it('includes a pending row for an admin, with when they asked', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({ membership: MEMBERSHIP, scope: SCOPE });
    vi.mocked(listGroupMembers).mockResolvedValue([MEMBERSHIP, PENDING_MEMBERSHIP]);

    const response = await invoke(
      MEMBERS_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.map((m: { userId: string }) => m.userId)).toEqual(['user_a', 'user_p']);
    // `groupMemberSchema` requires `requestedAt`, and an admin deciding on a
    // request needs to know how long it has waited.
    expect(body.data[1]).toMatchObject({
      joinedAt: null,
      requestedAt: PENDING_MEMBERSHIP.requestedAt.toISOString(),
    });
  });

  it('withholds a pending row from a non-admin', async () => {
    const memberRole = { ...MEMBERSHIP, role: 'member' };
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: memberRole,
      scope: MEMBER_SCOPE,
    });
    vi.mocked(listGroupMembers).mockResolvedValue([memberRole, PENDING_MEMBERSHIP]);

    const response = await invoke(
      MEMBERS_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/members`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(body.data.map((m: { userId: string }) => m.userId)).toEqual(['user_a']);
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

describe('GET /api/v1/resparkable/groups/[id]/join-links', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/join-links`;

  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(listJoinLinksForAdmin).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(JOIN_LINKS_GET, req(url), { id: GROUP_ID });

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(listJoinLinksForAdmin).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(JOIN_LINKS_GET, req(url), { id: GROUP_ID });

    expect(response.status).toBe(403);
  });

  it('lists the group’s join links for an admin, never a token', async () => {
    const link = {
      id: 'link_1',
      tokenPrefix: 'abc123',
      role: 'member',
      approval: 'request',
      maxUses: null,
      useCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-09-25T00:00:00.000Z'),
    };
    vi.mocked(listJoinLinksForAdmin).mockResolvedValue({ ok: true, links: [link] });

    const response = await invoke(JOIN_LINKS_GET, req(url), { id: GROUP_ID });
    const body = await response.json();

    expect(body.meta.count).toBe(1);
    expect(body.data[0]).toMatchObject({ id: 'link_1', tokenPrefix: 'abc123' });
    // A prefix only, never the plaintext token or its digest: the list is not
    // the response that carries the credential.
    expect(body.data[0]).not.toHaveProperty('token');
    expect(body.data[0]).not.toHaveProperty('tokenHash');
  });
});

describe('POST /api/v1/resparkable/groups/[id]/join-links', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/join-links`;

  it('rejects a role of admin at the schema, before the service is ever reached (13i)', async () => {
    const response = await invoke(
      JOIN_LINKS_POST,
      req(url, { role: 'admin', expiry: { kind: 'never' } }),
      { id: GROUP_ID }
    );

    // No link can confer admin. Asserted here, at the mint route's own
    // boundary, and again in the service; this pins the boundary half.
    expect(response.status).toBe(400);
    expect(mintJoinLink).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<{ reason: string; status: number }> = [
    { reason: 'not_a_member', status: 404 },
    { reason: 'not_an_admin', status: 403 },
    { reason: 'admin_link', status: 400 },
  ];

  for (const { reason, status } of REFUSALS) {
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(mintJoinLink).mockResolvedValue({ ok: false, reason: reason as never });

      const response = await invoke(
        JOIN_LINKS_POST,
        req(url, { role: 'member', expiry: { kind: 'never' } }),
        { id: GROUP_ID }
      );

      expect(response.status).toBe(status);
    });
  }

  it('answers 201 with the token and url the service minted', async () => {
    const createdAt = new Date('2026-09-25T00:00:00.000Z');
    vi.mocked(mintJoinLink).mockResolvedValue({
      ok: true,
      link: {
        id: 'link_1',
        tokenPrefix: 'abc123',
        role: 'member',
        approval: 'request',
        maxUses: null,
        useCount: 0,
        expiresAt: null,
        revokedAt: null,
        createdAt,
      },
      token: 'plaintext-token-value',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token-value',
    });

    const response = await invoke(
      JOIN_LINKS_POST,
      req(url, { role: 'member', expiry: { kind: 'never' } }),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.token).toBe('plaintext-token-value');
    expect(body.data.url).toBe(
      'https://resparkable.test/resparkable/groups/join/plaintext-token-value'
    );
  });

  it('never writes the token or the url to a log line: either one is the credential', async () => {
    vi.mocked(mintJoinLink).mockResolvedValue({
      ok: true,
      link: {
        id: 'link_1',
        tokenPrefix: 'abc123',
        role: 'member',
        approval: 'request',
        maxUses: null,
        useCount: 0,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date('2026-09-25T00:00:00.000Z'),
      },
      token: 'plaintext-token-value',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token-value',
    });

    await invoke(JOIN_LINKS_POST, req(url, { role: 'member', expiry: { kind: 'never' } }), {
      id: GROUP_ID,
    });

    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).not.toContain('plaintext-token-value');
    expect(logged).not.toContain('resparkable/groups/join');
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]/join-links/[linkId]', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/join-links/link_1`;

  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(revokeGroupJoinLink).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(JOIN_LINK_DELETE, req(url), {
      id: GROUP_ID,
      linkId: 'link_1',
    });

    expect(response.status).toBe(404);
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(revokeGroupJoinLink).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(JOIN_LINK_DELETE, req(url), {
      id: GROUP_ID,
      linkId: 'link_1',
    });

    expect(response.status).toBe(403);
  });

  it('revokes the link and reports it', async () => {
    vi.mocked(revokeGroupJoinLink).mockResolvedValue({ ok: true });

    const response = await invoke(JOIN_LINK_DELETE, req(url), {
      id: GROUP_ID,
      linkId: 'link_1',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ linkId: 'link_1', revoked: true });
  });
});

describe('POST /api/v1/resparkable/groups/[id]/join-requests/[userId]', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/join-requests/user_b`;

  const REFUSALS: Array<{ reason: string; status: number }> = [
    { reason: 'not_a_member', status: 404 },
    { reason: 'not_an_admin', status: 403 },
    { reason: 'no_such_member', status: 404 },
    { reason: 'group_full', status: 409 },
  ];

  for (const { reason, status } of REFUSALS) {
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(approveGroupJoinRequest).mockResolvedValue({ ok: false, reason: reason as never });

      const response = await invoke(JOIN_REQUEST_POST, req(url), {
        id: GROUP_ID,
        userId: 'user_b',
      });

      expect(response.status).toBe(status);
    });
  }

  it('approves the request and reports it', async () => {
    vi.mocked(approveGroupJoinRequest).mockResolvedValue({ ok: true });

    const response = await invoke(JOIN_REQUEST_POST, req(url), {
      id: GROUP_ID,
      userId: 'user_b',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ userId: 'user_b', approved: true });
  });
});

describe('DELETE /api/v1/resparkable/groups/[id]/join-requests/[userId]', () => {
  const url = `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/join-requests/user_b`;

  const REFUSALS: Array<{ reason: string; status: number }> = [
    { reason: 'not_a_member', status: 404 },
    { reason: 'not_an_admin', status: 403 },
    { reason: 'no_such_member', status: 404 },
  ];

  for (const { reason, status } of REFUSALS) {
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(rejectGroupJoinRequest).mockResolvedValue({ ok: false, reason: reason as never });

      const response = await invoke(JOIN_REQUEST_DELETE, req(url), {
        id: GROUP_ID,
        userId: 'user_b',
      });

      expect(response.status).toBe(status);
    });
  }

  it('rejects the request and reports it', async () => {
    vi.mocked(rejectGroupJoinRequest).mockResolvedValue({ ok: true });

    const response = await invoke(JOIN_REQUEST_DELETE, req(url), {
      id: GROUP_ID,
      userId: 'user_b',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ userId: 'user_b', rejected: true });
  });
});

describe('POST /api/v1/resparkable/groups/join', () => {
  const url = 'http://localhost/api/v1/resparkable/groups/join';

  it('rejects a malformed token, rather than reaching the service', async () => {
    const response = await invoke(JOIN_GROUP_POST, req(url, { token: 'too-short' }));

    expect(response.status).toBe(400);
    expect(redeemJoinLinkToken).not.toHaveBeenCalled();
  });

  const TOKEN = 'a'.repeat(32);

  const OUTCOMES: Array<'joined' | 'requested' | 'already_member' | 'already_requested'> = [
    'joined',
    'requested',
    'already_member',
    'already_requested',
  ];

  for (const outcome of OUTCOMES) {
    it(`answers 200 with outcome '${outcome}' and the group id and name on success`, async () => {
      vi.mocked(redeemJoinLinkToken).mockResolvedValue({
        ok: true,
        outcome,
        groupId: GROUP_ID,
        groupName: 'Study Group B',
      });

      const response = await invoke(JOIN_GROUP_POST, req(url, { token: TOKEN }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toEqual({
        outcome,
        groupId: GROUP_ID,
        groupName: 'Study Group B',
      });
    });
  }

  it('answers 200 with outcome group_full and the group name, never a 4xx', async () => {
    vi.mocked(redeemJoinLinkToken).mockResolvedValue({
      ok: false,
      reason: 'group_full',
      groupName: 'Study Group B',
    });

    const response = await invoke(JOIN_GROUP_POST, req(url, { token: TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ outcome: 'group_full', groupName: 'Study Group B' });
  });

  it('answers 200 with outcome unknown and no group name, for every bad-token reason alike', async () => {
    vi.mocked(redeemJoinLinkToken).mockResolvedValue({ ok: false, reason: 'unknown' });

    const response = await invoke(JOIN_GROUP_POST, req(url, { token: TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ outcome: 'unknown' });
    expect(body.data).not.toHaveProperty('groupName');
  });
});
