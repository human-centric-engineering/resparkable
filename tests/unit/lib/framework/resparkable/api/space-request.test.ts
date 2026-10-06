/**
 * Unit Tests: the route-level workspace resolution (phase 47).
 *
 * `requestSpaceScope` is one call, and it is the call every HTTP path in the
 * tier now makes instead of minting its own scope. Three things have to hold:
 *
 *   1. **It reads the target from the URL and nowhere else.** Not a header, not
 *      a body field, not ambient state.
 *   2. **A refusal is a `NotFoundError`**, never a forbidden. §16.2: a 403
 *      confirms the space exists to whoever guessed the id.
 *   3. **It passes the session's user id through unchanged**, because the one
 *      argument that must never come from the request is the actor.
 *
 * @see lib/framework/resparkable/api/space-request.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver is mocked; the role predicate is real, because the viewer gate
// is the behaviour under test and a mocked predicate would test the mock.
vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/services/membership')>()),
  resolveActiveSpaceScope: vi.fn(),
}));

import { ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';

const PERSONAL = { spaceId: 'user_a', actorUserId: 'user_a', role: 'owner' };
const AS_VIEWER = { spaceId: 'spc_g', actorUserId: 'user_a', role: 'viewer' };
const AS_MEMBER = { spaceId: 'spc_g', actorUserId: 'user_a', role: 'member' };
const URL_IN_GROUP = 'https://example.test/api/v1/resparkable/tasks?space=spc_g';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestSpaceScope', () => {
  it('passes the URL target and the session actor to the resolver', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(PERSONAL as never);

    await requestSpaceScope(
      new Request('https://example.test/api/v1/resparkable/today?space=spc_1'),
      'user_a'
    );

    // The order of these two arguments is the file's whole contract: the actor
    // is verified and the target is not.
    expect(resolveActiveSpaceScope).toHaveBeenCalledWith('user_a', 'spc_1');
  });

  it('asks for the personal space when the URL names none', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(PERSONAL as never);

    await requestSpaceScope(new Request('https://example.test/api/v1/resparkable/today'), 'user_a');

    expect(resolveActiveSpaceScope).toHaveBeenCalledWith('user_a', null);
  });

  it('ignores a space named anywhere but the query string', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(PERSONAL as never);

    await requestSpaceScope(
      new Request('https://example.test/api/v1/resparkable/today', {
        method: 'POST',
        headers: { 'x-resparkable-space': 'spc_smuggled', 'content-type': 'application/json' },
        body: JSON.stringify({ space: 'spc_smuggled', spaceId: 'spc_smuggled' }),
      }),
      'user_a'
    );

    // One place to look, so there is one place to audit. A header or a body
    // field that also worked would be a second, quieter way in.
    expect(resolveActiveSpaceScope).toHaveBeenCalledWith('user_a', null);
  });

  it('throws a not-found when the resolver refuses', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(null);

    const call = requestSpaceScope(
      new Request('https://example.test/api/v1/resparkable/today?space=spc_someone_elses'),
      'user_a'
    );

    await expect(call).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names no space id in the refusal message', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(null);

    await expect(
      requestSpaceScope(
        new Request('https://example.test/api/v1/resparkable/today?space=spc_secret'),
        'user_a'
      )
    ).rejects.toThrow(/^Workspace not found$/);
  });

  it('returns the scope the resolver minted, untouched', async () => {
    const groupScope = { spaceId: 'spc_1', actorUserId: 'user_a', role: 'member' };
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(groupScope as never);

    const scope = await requestSpaceScope(
      new Request('https://example.test/api/v1/resparkable/today?space=spc_1'),
      'user_a'
    );

    // This file mints nothing and narrows nothing. If it ever did, it would be
    // a second trust boundary sitting outside `services/membership.ts`.
    expect(scope).toBe(groupScope);
  });
});

/**
 * Test 13o, the route chokepoint: a viewer reads and writes nothing (§23.3).
 * Every content route resolves its workspace here, so refusing here is what
 * makes the role real on every route, including ones added later.
 */
describe('requestSpaceScope: the viewer gate', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'refuses a viewer a %s with a 403',
    async (method) => {
      vi.mocked(resolveActiveSpaceScope).mockResolvedValue(AS_VIEWER as never);

      const call = requestSpaceScope(new Request(URL_IN_GROUP, { method }), 'user_a');

      // 403, not 404: a viewer is a member and can already see the space.
      await expect(call).rejects.toBeInstanceOf(ForbiddenError);
    }
  );

  it.each(['GET', 'HEAD'])('lets a viewer %s', async (method) => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(AS_VIEWER as never);

    await expect(
      requestSpaceScope(new Request(URL_IN_GROUP, { method }), 'user_a')
    ).resolves.toEqual(AS_VIEWER);
  });

  it('lets a viewer make a non-GET the route declares a read', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(AS_VIEWER as never);

    await expect(
      requestSpaceScope(new Request(URL_IN_GROUP, { method: 'POST' }), 'user_a', {
        access: 'read',
      })
    ).resolves.toEqual(AS_VIEWER);
  });

  it('refuses a viewer a GET the route declares a write', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(AS_VIEWER as never);

    await expect(
      requestSpaceScope(new Request(URL_IN_GROUP), 'user_a', { access: 'write' })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a member and an owner write', async () => {
    vi.mocked(resolveActiveSpaceScope).mockResolvedValueOnce(AS_MEMBER as never);
    await expect(
      requestSpaceScope(new Request(URL_IN_GROUP, { method: 'POST' }), 'user_a')
    ).resolves.toEqual(AS_MEMBER);

    vi.mocked(resolveActiveSpaceScope).mockResolvedValueOnce(PERSONAL as never);
    await expect(
      requestSpaceScope(
        new Request('https://example.test/api/v1/resparkable/tasks', { method: 'POST' }),
        'user_a'
      )
    ).resolves.toEqual(PERSONAL);
  });

  it('still answers a non-member with a 404, never a 403', async () => {
    // The gate runs after membership: a write from somebody outside the space
    // must not learn that the space exists.
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(null);

    await expect(
      requestSpaceScope(new Request(URL_IN_GROUP, { method: 'POST' }), 'user_a')
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
