/**
 * Route Tests: the group activity feed (phase 59, §23.10).
 *
 * Polled, never pushed: an unchanged page is a 304 with no body. And "mark as
 * seen" is the one non-GET a group viewer may make, because it writes only
 * their own membership row.
 *
 * @see app/api/v1/resparkable/feed/route.ts
 * @see app/api/v1/resparkable/feed/seen/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/framework/resparkable/api/space-request', () => ({ requestSpaceScope: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/services/feed')>()),
  buildFeed: vi.fn(),
  markFeedSeen: vi.fn(),
}));

import { GET } from '@/app/api/v1/resparkable/feed/route';
import { POST as SEEN } from '@/app/api/v1/resparkable/feed/seen/route';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import { buildFeed, markFeedSeen } from '@/lib/framework/resparkable/services/feed';

const SESSION = { user: { id: 'user_me' }, session: { userId: 'user_me' } };
const SCOPE = spaceScopeFor({ spaceId: 'spc_g', actorUserId: 'user_me', role: 'viewer' });
const PAGE = {
  items: [
    {
      id: 'evt_1',
      kind: 'created',
      entityType: 'task',
      entityId: 'task_1',
      title: 'Chapter 4 notes',
      actorName: 'Sam',
      byYou: false,
      system: false,
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
    },
  ],
  nextCursor: null,
  seenAt: null,
};

function req(query = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/v1/resparkable/feed?space=spc_g${query}`, { headers });
}

function invoke(handler: unknown, request: Request): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, SESSION);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestSpaceScope).mockResolvedValue(SCOPE);
  vi.mocked(buildFeed).mockResolvedValue(PAGE);
  vi.mocked(markFeedSeen).mockResolvedValue(true);
});

describe('GET /api/v1/resparkable/feed', () => {
  it('returns the page with an ETag', async () => {
    const response = await invoke(GET, req());

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeTruthy();
    const body = await response.json();
    expect(body.data.items[0].title).toBe('Chapter 4 notes');
  });

  it('answers an unchanged page with a 304 and no body', async () => {
    const first = await invoke(GET, req());
    const etag = first.headers.get('ETag') ?? '';

    const second = await invoke(GET, req('', { 'If-None-Match': etag }));

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('404s in a personal workspace', async () => {
    vi.mocked(buildFeed).mockResolvedValue(null);

    expect((await invoke(GET, req())).status).toBe(404);
  });

  it('passes the cursor and the member filter through', async () => {
    await invoke(
      GET,
      req(`&before=${encodeURIComponent('2026-09-30T00:00:00.000Z|evt_9')}&member=user_sam`)
    );

    expect(buildFeed).toHaveBeenCalledWith(SCOPE, {
      before: { createdAt: new Date('2026-09-30T00:00:00.000Z'), id: 'evt_9' },
      memberUserId: 'user_sam',
    });
  });

  it('refuses a cursor that is not a date', async () => {
    expect((await invoke(GET, req('&before=yesterday-ish'))).status).toBe(400);
  });
});

describe('POST /api/v1/resparkable/feed/seen', () => {
  it('is declared a read, so a group viewer may mark the feed seen', async () => {
    const response = await invoke(
      SEEN,
      new Request('http://localhost/x?space=spc_g', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(requestSpaceScope).mock.calls[0][2]).toEqual({ access: 'read' });
    expect(markFeedSeen).toHaveBeenCalledWith(SCOPE, expect.any(Date));
  });

  it('404s in a personal workspace', async () => {
    vi.mocked(markFeedSeen).mockResolvedValue(false);

    const response = await invoke(SEEN, new Request('http://localhost/x', { method: 'POST' }));

    expect(response.status).toBe(404);
  });
});
