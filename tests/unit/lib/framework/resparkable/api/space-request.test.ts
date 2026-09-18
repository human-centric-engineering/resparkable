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

vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  resolveActiveSpaceScope: vi.fn(),
}));

import { NotFoundError } from '@/lib/api/errors';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';

const PERSONAL = { spaceId: 'user_a', actorUserId: 'user_a', role: 'owner' };

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
