/**
 * Unit Tests: the named-grant and shared-with-me routes (Release 2, phase 12).
 *
 * The routes are thin, and the things worth asserting about them are the ones a
 * thin handler gets wrong:
 *
 * Test Coverage (plan §16.2, §16.3):
 * - Sharing an item the caller does not own is a **404, never a 403** — a 403
 *   confirms the row exists to somebody who guessed an id
 * - The grantee's address never reaches a log line
 * - The viewer is built from the session, never from the request: a body
 *   carrying `granteeEmail: someone-else` cannot make the server read as them
 * - `/shared` and `/shared/[type]/[id]` have no write verbs at all
 * - Every failure on the shared-item route is the same 404
 * - A revoke that moves nothing is a 404, so the audit timestamp cannot be
 *   restamped by a double press
 *
 * @see app/api/v1/resparkable/grants/route.ts
 * @see app/api/v1/resparkable/grants/[id]/route.ts
 * @see app/api/v1/resparkable/shared/route.ts
 * @see app/api/v1/resparkable/shared/[entityType]/[entityId]/route.ts
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

vi.mock('@/lib/framework/resparkable/services/grants', () => ({
  issueGrant: vi.fn(),
  listOwnGrants: vi.fn(),
  updateGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/shared-with-me', () => ({
  listSharedWithMe: vi.fn(),
  readSharedWithMe: vi.fn(),
  searchSharedWithMe: vi.fn(),
}));

import { GET as GRANTS_GET, POST as GRANTS_POST } from '@/app/api/v1/resparkable/grants/route';
import {
  DELETE as GRANT_DELETE,
  PATCH as GRANT_PATCH,
} from '@/app/api/v1/resparkable/grants/[id]/route';
import { GET as SHARED_GET } from '@/app/api/v1/resparkable/shared/route';
import { GET as SHARED_SEARCH_GET } from '@/app/api/v1/resparkable/shared/search/route';
import { GET as SHARED_ITEM_GET } from '@/app/api/v1/resparkable/shared/[entityType]/[entityId]/route';
import {
  issueGrant,
  listOwnGrants,
  revokeGrant,
  updateGrant,
} from '@/lib/framework/resparkable/services/grants';
import {
  listSharedWithMe,
  readSharedWithMe,
  searchSharedWithMe,
} from '@/lib/framework/resparkable/services/shared-with-me';

const SESSION = {
  user: { id: 'user_a', email: 'A@Example.com' },
  session: { userId: 'user_a' },
};

const PROJECT_ID = 'clh0000000000000000000001';

const SUMMARY = {
  id: 'grant_1',
  entityType: 'project',
  entityId: PROJECT_ID,
  granteeEmail: 'b@example.com',
  role: 'viewer',
  includeTaskDetail: false,
  accepted: false,
  invitedAt: null,
  expiresAt: null,
  revokedAt: null,
  active: true,
  createdAt: new Date('2026-08-28T10:00:00.000Z'),
};

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

describe('POST /api/v1/resparkable/grants', () => {
  it('creates a grant and returns 201', async () => {
    vi.mocked(issueGrant).mockResolvedValue(SUMMARY);

    const response = await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'project',
        entityId: PROJECT_ID,
        granteeEmail: 'b@example.com',
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.grant.id).toBe('grant_1');
  });

  it('is a 404, not a 403, for an item the caller does not own', async () => {
    vi.mocked(issueGrant).mockResolvedValue(null);

    const response = await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'project',
        entityId: PROJECT_ID,
        granteeEmail: 'b@example.com',
      })
    );

    // A 403 would confirm the row exists to somebody who guessed an id, which
    // is the enumeration vector every read in this tier declines to offer.
    expect(response.status).toBe(404);
  });

  it('never writes the grantee’s address to a log line', async () => {
    vi.mocked(issueGrant).mockResolvedValue(SUMMARY);

    await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'project',
        entityId: PROJECT_ID,
        granteeEmail: 'b@example.com',
      })
    );

    // One person's contact details in another person's infrastructure, for the
    // life of the log.
    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).not.toContain('b@example.com');
  });

  it('lower-cases the address before it reaches the service', async () => {
    vi.mocked(issueGrant).mockResolvedValue(SUMMARY);

    await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'project',
        entityId: PROJECT_ID,
        granteeEmail: '  B@Example.COM ',
      })
    );

    // The unique index and `granteeClauses` both work on the lower-cased form.
    // An un-normalised write is a second grant row for one person, and a grant
    // nobody can match.
    expect(vi.mocked(issueGrant).mock.calls[0][1].granteeEmail).toBe('b@example.com');
  });

  it('rejects a body naming a userId, rather than silently ignoring it', async () => {
    const response = await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'project',
        entityId: PROJECT_ID,
        granteeEmail: 'b@example.com',
        userId: 'user_c',
      })
    );

    expect(response.status).toBe(400);
    expect(issueGrant).not.toHaveBeenCalled();
  });

  it('refuses to share a thought, because the capture inbox is unshareable', async () => {
    const response = await invoke(
      GRANTS_POST,
      req('http://localhost/api/v1/resparkable/grants', {
        entityType: 'thought',
        entityId: PROJECT_ID,
        granteeEmail: 'b@example.com',
      })
    );

    expect(response.status).toBe(400);
    expect(issueGrant).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/resparkable/grants', () => {
  it('lists the owner’s grants with a count', async () => {
    vi.mocked(listOwnGrants).mockResolvedValue([SUMMARY]);

    const response = await invoke(
      GRANTS_GET,
      req('http://localhost/api/v1/resparkable/grants?entityType=project')
    );

    const body = await response.json();
    expect(body.meta.count).toBe(1);
    expect(body.data).toHaveLength(1);
  });
});

describe('PATCH and DELETE /api/v1/resparkable/grants/[id]', () => {
  it('404s a grant that is not this owner’s', async () => {
    vi.mocked(updateGrant).mockResolvedValue(null);

    const response = await invoke(
      GRANT_PATCH,
      req('http://localhost/api/v1/resparkable/grants/grant_x', { role: 'commenter' }),
      { id: 'grant_x' }
    );

    expect(response.status).toBe(404);
  });

  it('refuses to re-address a grant through PATCH', async () => {
    const response = await invoke(
      GRANT_PATCH,
      req('http://localhost/api/v1/resparkable/grants/grant_1', {
        granteeEmail: 'c@example.com',
      }),
      { id: 'grant_1' }
    );

    // Moving access between mailboxes is a revoke plus a new grant, not an
    // edit. A PATCH that did it would leave the row's history saying nothing
    // had happened.
    expect(response.status).toBe(400);
    expect(updateGrant).not.toHaveBeenCalled();
  });

  it('404s a second revoke, so the audit timestamp is not restamped', async () => {
    vi.mocked(revokeGrant).mockResolvedValueOnce({ ...SUMMARY, revokedAt: new Date() });
    const first = await invoke(
      GRANT_DELETE,
      req('http://localhost/api/v1/resparkable/grants/grant_1'),
      { id: 'grant_1' }
    );
    expect(first.status).toBe(200);

    vi.mocked(revokeGrant).mockResolvedValueOnce(null);
    const second = await invoke(
      GRANT_DELETE,
      req('http://localhost/api/v1/resparkable/grants/grant_1'),
      { id: 'grant_1' }
    );
    expect(second.status).toBe(404);
  });
});

describe('the shared-with-me surface', () => {
  it('has no write verbs at all', async () => {
    const list = await import('@/app/api/v1/resparkable/shared/route');
    const item = await import('@/app/api/v1/resparkable/shared/[entityType]/[entityId]/route');
    const search = await import('@/app/api/v1/resparkable/shared/search/route');

    // A grant is `viewer` or `commenter`; neither implies any authority over
    // the item. Asserted as an absence over the modules rather than by trying
    // each verb, so a POST added tomorrow fails here rather than shipping.
    for (const routeModule of [list, item, search]) {
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(routeModule).not.toHaveProperty(verb);
      }
    }
  });

  it('builds the viewer from the session, lower-cased, and never from the request', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue([]);

    await invoke(SHARED_GET, req('http://localhost/api/v1/resparkable/shared'));

    // The session's address is `A@Example.com`; grants are stored lower-cased,
    // so a viewer carrying the mixed-case form silently holds none of them.
    expect(vi.mocked(listSharedWithMe).mock.calls[0][0]).toEqual({
      userId: 'user_a',
      email: 'a@example.com',
    });
  });

  it('404s every failure on the item route with the same answer', async () => {
    vi.mocked(readSharedWithMe).mockResolvedValue(null);

    for (const [entityType, entityId] of [
      ['project', PROJECT_ID],
      ['thought', PROJECT_ID],
      ['not-a-type', 'not-an-id'],
    ]) {
      const response = await invoke(
        SHARED_ITEM_GET,
        req(`http://localhost/api/v1/resparkable/shared/${entityType}/${entityId}`),
        { entityType, entityId }
      );
      // Unshareable type, unknown id and no grant are indistinguishable. A 400
      // for one of them would tell a guesser which types are shareable and
      // separate "wrong type" from "no access".
      expect(response.status).toBe(404);
    }
  });

  it('reports truncation on the search rather than silently showing a short list', async () => {
    vi.mocked(searchSharedWithMe).mockResolvedValue({ items: [], truncated: true });

    const response = await invoke(
      SHARED_SEARCH_GET,
      req('http://localhost/api/v1/resparkable/shared/search?q=anything')
    );

    const body = await response.json();
    expect(body.meta.truncated).toBe(true);
  });

  it('never logs the search term', async () => {
    vi.mocked(searchSharedWithMe).mockResolvedValue({ items: [], truncated: false });

    await invoke(
      SHARED_SEARCH_GET,
      req('http://localhost/api/v1/resparkable/shared/search?q=redundancy%20plan')
    );

    // What somebody looks for inside another person's shared project is not
    // something an operator needs.
    expect(JSON.stringify(routeLog.info.mock.calls)).not.toContain('redundancy');
  });

  it('rejects an empty search rather than scanning everything', async () => {
    const response = await invoke(
      SHARED_SEARCH_GET,
      req('http://localhost/api/v1/resparkable/shared/search?q=')
    );

    expect(response.status).toBe(400);
    expect(searchSharedWithMe).not.toHaveBeenCalled();
  });
});
