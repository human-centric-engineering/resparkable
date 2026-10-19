/**
 * Unit Tests: `GET /api/v1/resparkable/groups/[id]/books` (phase 62).
 *
 * The rules (who is listed, how weeks bucket) are in `services/group-books.ts`
 * and covered there. What the route owns:
 *
 *   - A non-member gets a 404, not a 403, so a guessed id confirms nothing.
 *   - `?weeks=` is validated (1 to 52, whole, default 12) before the service
 *     is called, and passed through when valid.
 *   - The service's view is returned under `data`.
 *
 * @see app/api/v1/resparkable/groups/[id]/books/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/api/context', () => ({ getRouteLogger: async () => routeLog }));

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

vi.mock('@/lib/framework/resparkable/services/group-books', () => ({
  getGroupBooks: vi.fn(),
}));

import { GET } from '@/app/api/v1/resparkable/groups/[id]/books/route';
import { getGroupBooks } from '@/lib/framework/resparkable/services/group-books';
import { makeBooks } from '@/tests/helpers/resparkable-group-budget';

const SESSION = { user: { id: 'user_a', email: 'a@example.com' }, session: { userId: 'user_a' } };
const GROUP_ID = 'grp_1';

function call(query = ''): Promise<Response> {
  const request = {
    url: `http://localhost/api/v1/resparkable/groups/${GROUP_ID}/books${query}`,
    headers: new Headers(),
  } as unknown as Request;
  const handler = GET as unknown as (
    request: unknown,
    session: unknown,
    context: unknown
  ) => Promise<Response>;
  return handler(request, SESSION, { params: Promise.resolve({ id: GROUP_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGroupBooks).mockResolvedValue({ ok: true, value: makeBooks() });
});

describe('GET /api/v1/resparkable/groups/[id]/books', () => {
  it('is a 404, not a 403, for a group the caller is not a member of', async () => {
    vi.mocked(getGroupBooks).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
  });

  it('returns the books under data for the session user and the group in the path', async () => {
    const view = makeBooks({ poolBalanceCredits: 33 });
    vi.mocked(getGroupBooks).mockResolvedValue({ ok: true, value: view });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: view });
    expect(getGroupBooks).toHaveBeenCalledWith('user_a', GROUP_ID, 12);
  });

  it('passes ?weeks= through to the service', async () => {
    await call('?weeks=26');

    expect(getGroupBooks).toHaveBeenCalledWith('user_a', GROUP_ID, 26);
  });

  it.each(['0', '53', '-1', '1.5', 'abc'])(
    'rejects ?weeks=%s with a 400, before the service is called',
    async (weeks) => {
      const response = await call(`?weeks=${weeks}`);

      expect(response.status).toBe(400);
      expect(getGroupBooks).not.toHaveBeenCalled();
    }
  );

  it.each(['1', '52'])('accepts the boundary ?weeks=%s', async (weeks) => {
    const response = await call(`?weeks=${weeks}`);

    expect(response.status).toBe(200);
    expect(getGroupBooks).toHaveBeenCalledWith('user_a', GROUP_ID, Number(weeks));
  });

  it('rejects an unknown query parameter, so a ?space= cannot redirect the read', async () => {
    const response = await call('?space=spc_other');

    expect(response.status).toBe(400);
    expect(getGroupBooks).not.toHaveBeenCalled();
  });
});
