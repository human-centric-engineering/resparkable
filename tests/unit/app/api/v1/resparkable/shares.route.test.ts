/**
 * Unit Tests: `GET /api/v1/resparkable/shares` — the outbound-share inventory.
 *
 * A thin handler, so the assertions are the ones a thin handler gets wrong:
 *
 * - **The scope comes from the session, never from the request.** A query
 *   string naming another user must not change whose shares come back. This is
 *   the one that matters: the route lists grants, and a scope taken from input
 *   would list somebody else's.
 * - **No grantee address reaches a log line.** The same rule §13 sets for every
 *   route on this surface; the summary is counts and nothing else.
 * - **`includeInactive` defaults to off and is not coerced.** `Boolean('false')`
 *   is `true`, which is how a safe default silently becomes the wide one.
 * - **There are no write verbs.** Revoking goes through the existing grant and
 *   share-link routes; a second revoke path here would be a second definition
 *   of what revocation means.
 *
 * @see app/api/v1/resparkable/shares/route.ts
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

vi.mock('@/lib/framework/resparkable/services/my-shares', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/framework/resparkable/services/my-shares')
  >('@/lib/framework/resparkable/services/my-shares');
  return { ...actual, listMyShares: vi.fn() };
});

import * as SharesRoute from '@/app/api/v1/resparkable/shares/route';
import { GET } from '@/app/api/v1/resparkable/shares/route';
import { listMyShares } from '@/lib/framework/resparkable/services/my-shares';

const SESSION = { user: { id: 'user_a', email: 'a@example.com' }, session: { userId: 'user_a' } };

const mocked = vi.mocked(listMyShares);

function request(query = ''): Request {
  return new Request(`https://resparkable.test/api/v1/resparkable/shares${query}`);
}

/**
 * Same shape as `grants.routes.test.ts`'s helper, and for the same reason: the
 * mocked `withAuth` hands the handler three arguments, while the exported
 * `GET`'s type is the one-argument route signature.
 */
function invoke(request: Request, session: unknown = SESSION): Promise<Response> {
  const fn = GET as unknown as (
    request: unknown,
    session: unknown,
    context: unknown
  ) => Promise<Response>;
  return fn(request, session, undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.mockResolvedValue([]);
});

describe('GET /api/v1/resparkable/shares', () => {
  it('scopes to the session user, whoever else the request names', async () => {
    await invoke(request(), { ...SESSION, user: { id: 'user_a', email: 'a@example.com' } });

    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]?.[0]).toMatchObject({ spaceId: 'user_a' });

    // A different session, a different scope, and nothing in between reads the
    // request. This route lists grants, so a scope taken from input would list
    // somebody else's.
    mocked.mockClear();
    await invoke(request(), { ...SESSION, user: { id: 'user_b', email: 'b@example.com' } });

    expect(mocked.mock.calls[0]?.[0]).toMatchObject({ spaceId: 'user_b' });
  });

  it('rejects a query parameter that looks like a scope', async () => {
    const response = await invoke(request('?userId=user_b'));

    // `.strict()` again: a param the schema does not name is a 400, so a
    // scope-shaped one cannot be silently ignored either.
    expect(response.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('defaults includeInactive to off', async () => {
    await invoke(request());

    expect(mocked.mock.calls[0]?.[1]).toEqual({ includeInactive: false });
  });

  it('reads includeInactive=false as false rather than coercing it to true', async () => {
    await invoke(request('?includeInactive=false'));

    // `Boolean('false')` is `true`. Coercion here would turn the safe default
    // into the wide one for anybody who passed the flag explicitly.
    expect(mocked.mock.calls[0]?.[1]).toEqual({ includeInactive: false });
  });

  it('honours includeInactive=true', async () => {
    await invoke(request('?includeInactive=true'));

    expect(mocked.mock.calls[0]?.[1]).toEqual({ includeInactive: true });
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    const response = await invoke(request('?entityType=project'));

    // `.strict()`: this surface deliberately has no entity filter, because it
    // exists for shares whose entity the owner cannot name.
    expect(response.status).toBe(400);
  });

  it('returns the items with counts in meta', async () => {
    mocked.mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'proj_1',
        title: 'Q4 launch',
        archived: true,
        grants: [{ id: 'g1' }],
        links: [],
      },
    ] as never);

    const response = await invoke(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({ items: 1, grants: 1, links: 0, unreachable: 1 });
  });

  it('logs counts and never a grantee address', async () => {
    mocked.mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'proj_1',
        title: 'Q4 launch',
        archived: false,
        grants: [{ id: 'g1', granteeEmail: 'friend@example.com' }],
        links: [],
      },
    ] as never);

    await invoke(request());

    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).not.toContain('friend@example.com');
    expect(routeLog.info).toHaveBeenCalledWith(
      'Resparkable outbound shares listed',
      expect.objectContaining({ items: 1 })
    );
  });

  it('exposes no write verbs', () => {
    // Revoking stays on the grant and share-link routes. Two definitions of
    // what revocation means would drift.
    expect(SharesRoute).not.toHaveProperty('POST');
    expect(SharesRoute).not.toHaveProperty('PATCH');
    expect(SharesRoute).not.toHaveProperty('PUT');
    expect(SharesRoute).not.toHaveProperty('DELETE');
  });
});
