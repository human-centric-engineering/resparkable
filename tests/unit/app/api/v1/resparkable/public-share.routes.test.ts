/**
 * Unit Tests: the public share surface (Release 2, phase 11).
 *
 * `GET /api/v1/resparkable/public/[token]` is the **only unauthenticated route
 * in the tier**, and the only one whose credential travels in a URL path that
 * gets pasted into chat windows and emails. Everything asserted here is about
 * that, and the assertions are worth more than the code they cover.
 *
 * Test Coverage (plan §16.4, tests 14–18):
 * - A live token returns the payload
 * - Unknown, malformed, revoked and expired are the SAME 404 — status, body
 *   and headers alike
 * - Every response carries `X-Robots-Tag`, `Referrer-Policy: no-referrer` and a
 *   no-store cache header — the 404 as well as the 200
 * - The token never appears in a log line
 * - Owner-side mint returns the plaintext once; the list never returns it
 * - Minting against someone else's item is a 404, not a 403
 *
 * `DELETE /api/v1/resparkable/share-links/[id]` (revocation) is covered in the
 * same file: it shares the `services/sharing` mock with the mint/list routes
 * above, and the enumeration-safety rule (404, never 403, on a miss) is the
 * same rule the POST route's own test already documents.
 *
 * @see app/api/v1/resparkable/public/[token]/route.ts
 * @see app/api/v1/resparkable/share-links/route.ts
 * @see app/api/v1/resparkable/share-links/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const routeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/api/context', () => ({ getRouteLogger: async () => routeLog }));

/**
 * The context bound to the public route's logger, captured.
 *
 * The route builds this itself instead of calling `getRouteLogger`, because the
 * shared helper binds `url` (the whole request URL) and `endpoint` (the
 * *resolved* pathname). On this route the token is a path segment, so both
 * would carry a working share link into every log line. Asserting the log
 * *fields* alone would not have caught that; the leak was in the context.
 */
const boundContext: Array<Record<string, unknown>> = [];

vi.mock('@/lib/logging', () => ({
  // The full surface, not just `withContext`: `handleAPIError` reaches for
  // `logger.error` on the guard's catch path, and a narrower stub turns an
  // assertion about a 404 into a TypeError about the mock.
  logger: {
    withContext: (context: Record<string, unknown>) => {
      boundContext.push(context);
      return routeLog;
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/logging/context', () => ({
  getFullContext: async () => ({
    requestId: 'req_1',
    visitorId: 'visitor_1',
    method: 'GET',
    // Present in the real helper's return, and both carry the token. The route
    // must drop them rather than spread the whole object.
    // Literal, not `LIVE_TOKEN`: a `vi.mock` factory is hoisted above the
    // module's own consts, so referencing one here is a TDZ error.
    url: 'https://resparkable.test/api/v1/resparkable/public/AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
    userAgent: 'test-agent',
  }),
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

vi.mock('@/lib/framework/resparkable/services/sharing', () => ({
  readPublicShare: vi.fn(),
  mintShareLink: vi.fn(),
  listOwnShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
}));

import { GET as PUBLIC_GET } from '@/app/api/v1/resparkable/public/[token]/route';
import { GET as LINKS_GET, POST as LINKS_POST } from '@/app/api/v1/resparkable/share-links/route';
import { DELETE as LINK_DELETE } from '@/app/api/v1/resparkable/share-links/[id]/route';
import {
  listOwnShareLinks,
  mintShareLink,
  readPublicShare,
  revokeShareLink,
} from '@/lib/framework/resparkable/services/sharing';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

/** 32 base64url characters: the shape `shareTokenSchema` accepts. */
const LIVE_TOKEN = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
const OTHER_TOKEN = 'ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS';

const PAYLOAD = {
  item: {
    entityType: 'project' as const,
    id: 'clh0000000000000000000001',
    title: 'Acme Redesign',
    body: 'The plan.',
    status: 'active',
    dueAt: null,
    horizon: null,
    archived: false,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    tags: [],
    checklist: null,
  },
  children: [],
  childrenTruncated: false,
  includeTaskDetail: false,
};

function publicReq(token: string) {
  return {
    url: `http://localhost:3000/api/v1/resparkable/public/${token}`,
    headers: new Headers(),
  } as unknown as Request;
}

function invokePublic(token: string): Promise<Response> {
  return PUBLIC_GET(publicReq(token), { params: Promise.resolve({ token }) });
}

function ownerReq(body?: unknown) {
  return {
    url: 'http://localhost:3000/api/v1/resparkable/share-links',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Request;
}

function invoke(handler: unknown, request: unknown, session: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPublicShare).mockResolvedValue(null);
  vi.mocked(listOwnShareLinks).mockResolvedValue([]);
  vi.mocked(revokeShareLink).mockResolvedValue(null);
  boundContext.length = 0;
});

/** A full `ResparkableShareLink` row, as `revokeShareLink` resolves it. */
function shareLinkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'clh0000000000000000000001',
    tokenHash: 'digest',
    tokenPrefix: LIVE_TOKEN.slice(0, 8),
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: new Date('2026-08-27T00:00:00Z'),
    viewCount: 2,
    lastViewedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-27T00:00:00Z'),
    ...overrides,
  };
}

function deleteReq(id: string) {
  return {
    url: `http://localhost:3000/api/v1/resparkable/share-links/${id}`,
    headers: new Headers(),
  } as unknown as Request;
}

function invokeDelete(id: string, session: unknown = SESSION): Promise<Response> {
  return (LINK_DELETE as (...args: unknown[]) => Promise<Response>)(deleteReq(id), session, {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/v1/resparkable/public/[token]', () => {
  it('returns the payload for a live token', async () => {
    vi.mocked(readPublicShare).mockResolvedValue(PAYLOAD);

    const response = await invokePublic(LIVE_TOKEN);
    const body = (await response.json()) as { success: boolean; data: { item: { title: string } } };

    expect(response.status).toBe(200);
    expect(body.data.item.title).toBe('Acme Redesign');
  });

  it('answers unknown, revoked and expired identically — status, body AND headers', async () => {
    // §16.4, and the assertion this whole route is shaped around. The service
    // already collapses the three into `null`; this proves the route does not
    // reintroduce a difference. Anything distinguishable turns the 404 into an
    // oracle telling a stranger which tokens once existed, and roughly when.
    vi.mocked(readPublicShare).mockResolvedValue(null);

    const unknown = await invokePublic(LIVE_TOKEN);
    const other = await invokePublic(OTHER_TOKEN);
    const malformed = await invokePublic('not-a-token');

    for (const response of [unknown, other, malformed]) {
      expect(response.status).toBe(404);
    }

    const bodies = await Promise.all([unknown.json(), other.json(), malformed.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);

    const headerSets = [unknown, other, malformed].map((response) =>
      [...response.headers.entries()].sort()
    );
    expect(headerSets[0]).toEqual(headerSets[1]);
    expect(headerSets[1]).toEqual(headerSets[2]);
  });

  it('rejects a malformed token without touching the database', async () => {
    await invokePublic('short');
    expect(readPublicShare).not.toHaveBeenCalled();
  });

  it('sets the three headers on a hit AND on a miss', async () => {
    // The miss is the one that matters. A 404 that skipped these would be
    // crawlable, referrer-leaking and cacheable — and distinguishable from a
    // hit by its headers alone.
    vi.mocked(readPublicShare).mockResolvedValue(PAYLOAD);
    const hit = await invokePublic(LIVE_TOKEN);

    vi.mocked(readPublicShare).mockResolvedValue(null);
    const miss = await invokePublic(LIVE_TOKEN);

    for (const response of [hit, miss]) {
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive, nosnippet');
      // The token is in the PATH. The global policy already strips the path
      // cross-origin; this sends nothing at all, including the origin.
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      // A revoked link must stop working immediately, and it cannot if a proxy
      // is still serving the last 200.
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
  });

  it('never writes the token to a log line', async () => {
    // A log line is the one place a bearer credential most reliably outlives
    // the system that issued it.
    vi.mocked(readPublicShare).mockResolvedValue(PAYLOAD);

    await invokePublic(LIVE_TOKEN);

    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).not.toContain(LIVE_TOKEN);
  });

  it('never writes the token into the logger context either', async () => {
    // The assertion above passes trivially: the route passes no token field.
    // It is not where the token got out. `getRouteLogger` binds `url` (the
    // whole request URL) and `endpoint` (the *resolved* pathname) to every line
    // a route emits, and the token is a path segment, so both carried a working
    // share link. `logger.sanitize` redacts by key name (`token`, `secret`,
    // `authorization`, …) and never by value, so neither field was touched, and
    // the line reached stdout and the admin log buffer that
    // `GET /api/v1/admin/logs` serves, whose `search` greps the serialised
    // context. Revoking a link does not scrub a log.
    vi.mocked(readPublicShare).mockResolvedValue(PAYLOAD);

    await invokePublic(LIVE_TOKEN);

    expect(
      boundContext,
      'the route must build its own log context: reverting it to getRouteLogger re-binds url and endpoint, and the token is in both'
    ).toHaveLength(1);
    expect(JSON.stringify(boundContext)).not.toContain(LIVE_TOKEN);
    // Positively: the route pattern, so a log reader can still tell which
    // endpoint served the request.
    expect(boundContext[0].endpoint).toBe('/api/v1/resparkable/public/[token]');
    // And `url` is dropped rather than spread through from `getFullContext`.
    expect(boundContext[0]).not.toHaveProperty('url');
  });
});

describe('POST /api/v1/resparkable/share-links', () => {
  const BODY = { entityType: 'project', entityId: 'clh0000000000000000000001' };

  it('returns the plaintext token exactly once, with the path to share', async () => {
    vi.mocked(mintShareLink).mockResolvedValue({
      token: LIVE_TOKEN,
      link: {
        id: 'link_1',
        userId: 'user_a',
        entityType: 'project',
        entityId: BODY.entityId,
        tokenHash: 'digest',
        tokenPrefix: LIVE_TOKEN.slice(0, 8),
        includeChildren: false,
        includeTaskDetail: false,
        expiresAt: new Date('2026-09-25T00:00:00Z'),
        revokedAt: null,
        viewCount: 0,
        lastViewedAt: null,
        createdAt: new Date('2026-08-26T00:00:00Z'),
        updatedAt: new Date('2026-08-26T00:00:00Z'),
      },
    });

    const response = await invoke(LINKS_POST, ownerReq(BODY), SESSION);
    const body = (await response.json()) as {
      data: { token: string; path: string; link: Record<string, unknown> };
    };

    expect(response.status).toBe(201);
    expect(body.data.token).toBe(LIVE_TOKEN);
    expect(body.data.path).toBe(`/s/${LIVE_TOKEN}`);
    // The digest never travels to a browser. It is not reversible, but it is
    // the exact value the public lookup matches on and there is no reason for
    // it to be in a client-side store or a screenshot.
    expect(body.data.link).not.toHaveProperty('tokenHash');
  });

  it('404s rather than 403s when the item is not the caller’s', async () => {
    // A 403 confirms the row exists, which is the enumeration vector every
    // other route in this tier declines to offer.
    vi.mocked(mintShareLink).mockResolvedValue(null);

    const response = await invoke(LINKS_POST, ownerReq(BODY), SESSION);

    expect(response.status).toBe(404);
  });

  it('refuses to publish a thought at validation, before any lookup', async () => {
    // The raw capture inbox is unshareable by construction. `entityType` is the
    // shareable enum, so this is a 400 rather than a permission check deeper in.
    const response = await invoke(
      LINKS_POST,
      ownerReq({ entityType: 'thought', entityId: 'clh0000000000000000000001' }),
      SESSION
    );

    expect(response.status).toBe(400);
    expect(mintShareLink).not.toHaveBeenCalled();
  });

  it('rejects an expiry beyond a year', async () => {
    const response = await invoke(
      LINKS_POST,
      ownerReq({ ...BODY, expiry: { kind: 'days', days: 400 } }),
      SESSION
    );

    expect(response.status).toBe(400);
  });

  it('accepts "never" only as an explicit choice', async () => {
    // A nullable number would make the strictest setting the one a client
    // reaches by omitting a field. The tagged union has to be typed out.
    vi.mocked(mintShareLink).mockResolvedValue(null);

    await invoke(LINKS_POST, ownerReq({ ...BODY, expiry: { kind: 'never' } }), SESSION);

    expect(vi.mocked(mintShareLink).mock.calls[0]?.[1].expiry).toEqual({ kind: 'never' });
  });

  it('defaults to thirty days when no expiry is given', async () => {
    vi.mocked(mintShareLink).mockResolvedValue(null);

    await invoke(LINKS_POST, ownerReq(BODY), SESSION);

    expect(vi.mocked(mintShareLink).mock.calls[0]?.[1].expiry).toEqual({ kind: 'days', days: 30 });
  });
});

describe('GET /api/v1/resparkable/share-links', () => {
  it('returns summaries that carry no token and no digest', async () => {
    vi.mocked(listOwnShareLinks).mockResolvedValue([
      {
        id: 'link_1',
        entityType: 'project',
        entityId: 'clh0000000000000000000001',
        tokenPrefix: 'AAAABBBB',
        includeChildren: false,
        includeTaskDetail: false,
        expiresAt: null,
        revokedAt: null,
        active: true,
        viewCount: 4,
        lastViewedAt: null,
        createdAt: new Date('2026-08-26T00:00:00Z'),
      },
    ]);

    const response = await invoke(
      LINKS_GET,
      { url: 'http://localhost:3000/api/v1/resparkable/share-links', headers: new Headers() },
      SESSION
    );
    const raw = JSON.stringify(await response.json());

    // A lost link is re-minted, not recovered — and this is what makes that
    // true rather than a promise.
    expect(raw).not.toContain(LIVE_TOKEN);
    expect(raw).not.toContain('tokenHash');
    expect(raw).toContain('AAAABBBB');
  });
});

describe('DELETE /api/v1/resparkable/share-links/[id]', () => {
  it('returns the documented success envelope on a successful revoke', async () => {
    const revoked = shareLinkRow();
    vi.mocked(revokeShareLink).mockResolvedValue(revoked);

    const response = await invokeDelete('link_1');
    const body = (await response.json()) as {
      success: boolean;
      data: { id: string; revokedAt: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: revoked.id, revokedAt: revoked.revokedAt.toISOString() });
  });

  it('404s, not 403s, when revokeShareLink finds no such link of the caller’s', async () => {
    // Same enumeration-safety rule the sibling POST route documents: a 403
    // would confirm the row exists (belongs to someone else) rather than not
    // existing at all, and the two must be indistinguishable to the caller.
    vi.mocked(revokeShareLink).mockResolvedValue(null);

    const response = await invokeDelete('not_mine');
    const body = (await response.json()) as { success: boolean };

    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
  });

  it('builds the owner scope from the session user id, never the request', async () => {
    vi.mocked(revokeShareLink).mockResolvedValue(shareLinkRow({ userId: 'user_b' }));

    await invokeDelete('link_1', { user: { id: 'user_b' }, session: { userId: 'user_b' } });

    // The scope handed to the service must carry the SESSION's id, not
    // anything read off the request/params: there is nothing in the request
    // this route could have taken it from instead, so this proves the route
    // reads `session.user.id` and not, say, a header or body field it forgot
    // to strip.
    expect(vi.mocked(revokeShareLink).mock.calls[0]?.[0]).toEqual({ userId: 'user_b' });
    expect(vi.mocked(revokeShareLink).mock.calls[0]?.[1]).toBe('link_1');
  });

  it('never logs the share token or its prefix', async () => {
    const revoked = shareLinkRow({ tokenPrefix: LIVE_TOKEN.slice(0, 8) });
    vi.mocked(revokeShareLink).mockResolvedValue(revoked);

    await invokeDelete('link_1');

    const logged = JSON.stringify(routeLog.info.mock.calls);
    expect(logged).not.toContain(LIVE_TOKEN);
    expect(logged).not.toContain(revoked.tokenPrefix);
  });
});
