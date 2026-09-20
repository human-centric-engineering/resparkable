/**
 * Unit Tests: the four connection-key routes.
 *
 * The handlers are thin, so this file asserts only the things a thin handler
 * gets wrong, in the same spirit as `groups.routes.test.ts`:
 *
 *   • **A workspace you are not in is 404, never 403.** A 403 confirms the
 *     workspace exists to whoever guessed an id.
 *   • **Minting a credential over a credential is refused.** An API-key session
 *     reaching POST or rotate could mint an MCP key acting as its owner, and
 *     the narrow scope the API key was issued with would then bound nothing.
 *     The *read* is deliberately allowed: listing your own key prefixes
 *     escalates nothing.
 *   • **The server being off is a 409, not a 503.** Nothing is broken and the
 *     caller's authority is fine; the install is in a state where this is not
 *     available, and the answer is "ask an administrator".
 *   • **No body is read anywhere.** Every field on the row is forced or
 *     derived, which is the whole reason a self-service credential surface is
 *     safe, so a handler that started trusting one would be the bug.
 *
 * The rules themselves (one per workspace, dead keys, what rotate may touch)
 * are covered by `mcp/keys.test.ts` and are not re-tested here.
 *
 * @see app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/route.ts
 * @see app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/[keyId]/route.ts
 * @see app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/[keyId]/rotate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const routeLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

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

vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  resolveActiveSpaceScope: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/mcp/keys', () => ({
  readConnectionKeys: vi.fn(),
  mintConnectionKey: vi.fn(),
  rotateConnectionKey: vi.fn(),
  revokeConnectionKey: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: () => '203.0.113.7' }));

import { GET, POST } from '@/app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/route';
import { DELETE } from '@/app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/[keyId]/route';
import { POST as ROTATE } from '@/app/api/v1/resparkable/spaces/[spaceId]/mcp-keys/[keyId]/rotate/route';
import {
  mintConnectionKey,
  readConnectionKeys,
  revokeConnectionKey,
  rotateConnectionKey,
} from '@/lib/framework/resparkable/mcp/keys';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';

const SPACE_ID = 'spc_group_alpha';
const KEY_ID = 'key_1';

const SESSION = {
  user: { id: 'user_a', name: 'Ada', email: 'a@example.com' },
  session: { id: 'sess_1', userId: 'user_a' },
};

/** A session authenticated by an API key rather than a browser cookie. */
const API_KEY_SESSION = {
  ...SESSION,
  session: { id: 'apikey_xyz', userId: 'user_a' },
};

const SCOPE = spaceScopeFor({ spaceId: SPACE_ID, actorUserId: 'user_a', role: 'member' });

const MINTED = {
  id: KEY_ID,
  keyPrefix: 'smcp_abcd12',
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  lastUsedAt: null,
  plaintext: 'smcp_PLAINTEXTSECRETVALUE0000000',
};

function request(url = `https://resparkable.test/api/v1/resparkable/spaces/${SPACE_ID}/mcp-keys`) {
  return new Request(url, { method: 'POST' });
}

function keyParams() {
  return { spaceId: SPACE_ID, keyId: KEY_ID };
}

function spaceParams() {
  return { spaceId: SPACE_ID };
}

/**
 * Call a route handler the way `withAuth` would.
 *
 * The exported handler's type says two arguments, because `withAuth` supplies
 * the session itself; the mock above passes three through. Same shape as
 * `groups.routes.test.ts`, so the cast lives in one place rather than at every
 * call site.
 */
function invoke(
  handler: unknown,
  request: Request,
  session: unknown,
  params: Record<string, string>
): Promise<Response> {
  const fn = handler as (request: unknown, session: unknown, context: unknown) => Promise<Response>;
  return fn(request, session, { params: Promise.resolve(params) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveSpaceScope).mockResolvedValue(SCOPE);
  vi.mocked(readConnectionKeys).mockResolvedValue({ serverEnabled: true, keys: [] });
  vi.mocked(mintConnectionKey).mockResolvedValue({ ok: true, value: MINTED });
  vi.mocked(rotateConnectionKey).mockResolvedValue({ ok: true, value: MINTED });
  vi.mocked(revokeConnectionKey).mockResolvedValue({ ok: true, value: { id: KEY_ID } });
});

describe('a workspace the caller is not in', () => {
  beforeEach(() => {
    // The one answer `resolveActiveSpaceScope` gives alike for a workspace that
    // does not exist, one the caller has left, and one they have only asked to
    // join.
    vi.mocked(resolveActiveSpaceScope).mockResolvedValue(null);
  });

  it.each([
    ['GET', () => invoke(GET, request(), SESSION, spaceParams())],
    ['POST', () => invoke(POST, request(), SESSION, spaceParams())],
    ['DELETE', () => invoke(DELETE, request(), SESSION, keyParams())],
    ['rotate', () => invoke(ROTATE, request(), SESSION, keyParams())],
  ])('%s is 404, never 403', async (_verb, call) => {
    const response = await call();

    expect(response.status).toBe(404);
  });

  it('names no workspace in the message', async () => {
    const response = await invoke(POST, request(), SESSION, spaceParams());
    const body = (await response.json()) as { error: { message: string } };

    // Saying "you are not a member of spc_group_alpha" would confirm the id,
    // which is the reason the status code is 404 in the first place.
    expect(body.error.message).not.toContain(SPACE_ID);
  });

  it('reaches no service', async () => {
    await invoke(POST, request(), SESSION, spaceParams());

    expect(mintConnectionKey).not.toHaveBeenCalled();
  });
});

describe('an API-key session', () => {
  it('cannot mint a key', async () => {
    const response = await invoke(POST, request(), API_KEY_SESSION, spaceParams());

    expect(response.status).toBe(403);
    expect(mintConnectionKey).not.toHaveBeenCalled();
  });

  it('cannot regenerate one either, which is the same act with an extra step', async () => {
    const response = await invoke(ROTATE, request(), API_KEY_SESSION, keyParams());

    expect(response.status).toBe(403);
    expect(rotateConnectionKey).not.toHaveBeenCalled();
  });

  it('is refused before the workspace is even resolved', async () => {
    // Order matters: refusing after resolution would let a credential probe
    // which workspace ids exist by the shape of the error it got back.
    await invoke(POST, request(), API_KEY_SESSION, spaceParams());

    expect(resolveActiveSpaceScope).not.toHaveBeenCalled();
  });

  it('leaves a warning naming the act, not the key', async () => {
    await invoke(POST, request(), API_KEY_SESSION, spaceParams());

    expect(routeLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rejected API-key attempt'),
      expect.objectContaining({ userId: 'user_a', verb: 'Creating' })
    );
  });

  it('cannot revoke one either', async () => {
    // The correction. Revoking makes no credential, which is why the first
    // draft allowed it, but core's own revoke route refuses for the reason
    // that matters more: guarding minting while leaving revocation open lets a
    // narrowly-scoped key list its owner's keys and destroy every one of them.
    const response = await invoke(DELETE, request(), API_KEY_SESSION, keyParams());

    expect(response.status).toBe(403);
    expect(revokeConnectionKey).not.toHaveBeenCalled();
  });

  it('may still read its own key list', async () => {
    // Listing prefixes escalates nothing, and refusing it would break a
    // legitimate scripted check of "is my assistant still connected".
    const response = await invoke(GET, request(), API_KEY_SESSION, spaceParams());

    expect(response.status).toBe(200);
  });
});

describe('GET', () => {
  it('returns the view as the service gave it', async () => {
    vi.mocked(readConnectionKeys).mockResolvedValue({
      serverEnabled: false,
      keys: [{ id: KEY_ID, keyPrefix: 'smcp_abcd12', createdAt: new Date(), lastUsedAt: null }],
    });

    const response = await invoke(GET, request(), SESSION, spaceParams());
    const body = (await response.json()) as { data: { serverEnabled: boolean } };

    expect(response.status).toBe(200);
    expect(body.data.serverEnabled).toBe(false);
  });
});

describe('POST', () => {
  it('answers 201 with the plaintext, once', async () => {
    const response = await invoke(POST, request(), SESSION, spaceParams());
    const body = (await response.json()) as { data: { plaintext: string } };

    expect(response.status).toBe(201);
    expect(body.data.plaintext).toBe(MINTED.plaintext);
  });

  it('reads no body at all', async () => {
    // A request carrying a scope, a name or an expiry gets exactly the same key
    // as one carrying nothing, because nothing about a key is the holder's to
    // choose.
    const withBody = new Request(
      `https://resparkable.test/api/v1/resparkable/spaces/${SPACE_ID}/mcp-keys`,
      {
        method: 'POST',
        body: JSON.stringify({ scopes: ['resources:read'], name: 'mine', expiresAt: null }),
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const response = await invoke(POST, withBody, SESSION, spaceParams());

    expect(response.status).toBe(201);
    expect(vi.mocked(mintConnectionKey).mock.calls[0][1]).toEqual({
      personName: 'Ada',
      clientIp: '203.0.113.7',
    });
  });

  it('logs the prefix and never the secret', async () => {
    await invoke(POST, request(), SESSION, spaceParams());

    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).toContain(MINTED.keyPrefix);
    expect(logged).not.toContain(MINTED.plaintext);
  });

  it('answers 409 when the MCP server is switched off', async () => {
    vi.mocked(mintConnectionKey).mockResolvedValue({ ok: false, reason: 'server_disabled' });

    const response = await invoke(POST, request(), SESSION, spaceParams());
    const body = (await response.json()) as { error: { message: string } };

    // 409 rather than 503: nothing is broken, and the answer is "ask an
    // administrator" rather than "try again in a minute".
    expect(response.status).toBe(409);
    expect(body.error.message).toContain('administrator');
  });

  it('answers 409 when a live key already exists, and says what to do instead', async () => {
    vi.mocked(mintConnectionKey).mockResolvedValue({ ok: false, reason: 'already_exists' });

    const response = await invoke(POST, request(), SESSION, spaceParams());
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(409);
    expect(body.error.message).toMatch(/[Rr]egenerate/);
  });
});

describe('rotate', () => {
  it('answers 200 with a fresh plaintext', async () => {
    const response = await invoke(ROTATE, request(), SESSION, keyParams());
    const body = (await response.json()) as { data: { plaintext: string } };

    expect(response.status).toBe(200);
    expect(body.data.plaintext).toBe(MINTED.plaintext);
  });

  it('answers 404 for a key that is not the caller’s, live and in this workspace', async () => {
    vi.mocked(rotateConnectionKey).mockResolvedValue({ ok: false, reason: 'no_such_key' });

    const response = await invoke(ROTATE, request(), SESSION, keyParams());

    expect(response.status).toBe(404);
  });
});

describe('DELETE', () => {
  it('reports the revocation', async () => {
    const response = await invoke(DELETE, request(), SESSION, keyParams());
    const body = (await response.json()) as { data: { id: string; revoked: boolean } };

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ id: KEY_ID, revoked: true });
  });

  it('answers 404 for somebody else’s key', async () => {
    vi.mocked(revokeConnectionKey).mockResolvedValue({ ok: false, reason: 'no_such_key' });

    const response = await invoke(DELETE, request(), SESSION, keyParams());

    expect(response.status).toBe(404);
  });

  it('requires a browser session, like the two verbs that make key material', async () => {
    // Asserted here as well as in the API-key block above, so deleting either
    // test still leaves the rule pinned on the verb it applies to.
    const response = await invoke(DELETE, request(), API_KEY_SESSION, keyParams());

    expect(response.status).toBe(403);
  });
});
