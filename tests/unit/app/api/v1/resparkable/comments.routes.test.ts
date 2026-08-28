/**
 * Unit Tests: the comment and invite routes (Release 2, phase 13).
 *
 * Test Coverage (plan §16.3):
 * - Every refusal to comment is the same 404 as a missing item — "you may look
 *   but not speak" as a distinguishable answer tells a guesser which items exist
 * - A comment body never reaches a log line
 * - The viewer is built from the session, never from the request body
 * - A thought cannot be commented on, because it cannot be shared
 * - Accepting an invite as the wrong account is a **200 with a masked address**,
 *   not an error: it is a state the page explains, and the mask is what stops a
 *   forwarded email handing a stranger a working address
 * - Every other invite failure is one 404
 * - A revoked grant cannot send a fresh invite
 *
 * @see app/api/v1/resparkable/comments/route.ts
 * @see app/api/v1/resparkable/invites/accept/route.ts
 * @see app/api/v1/resparkable/grants/[id]/invite/route.ts
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

vi.mock('@/lib/framework/resparkable/services/comments', () => ({
  listCommentsFor: vi.fn(),
  addComment: vi.fn(),
  updateComment: vi.fn(),
  removeComment: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/invites', () => ({
  sendGrantInvite: vi.fn(),
  acceptInvite: vi.fn(),
}));

import {
  GET as COMMENTS_GET,
  POST as COMMENTS_POST,
} from '@/app/api/v1/resparkable/comments/route';
import { POST as ACCEPT_POST } from '@/app/api/v1/resparkable/invites/accept/route';
import { POST as INVITE_POST } from '@/app/api/v1/resparkable/grants/[id]/invite/route';
import { addComment, listCommentsFor } from '@/lib/framework/resparkable/services/comments';
import { acceptInvite, sendGrantInvite } from '@/lib/framework/resparkable/services/invites';

const SESSION = {
  user: { id: 'user_b', email: 'B@Example.com' },
  session: { userId: 'user_b' },
};

const PROJECT_ID = 'clh0000000000000000000001';

const COMMENT = {
  id: 'c_1',
  body: 'Looks right to me',
  author: { id: 'user_b', name: 'Bo', isOwner: false },
  mine: true,
  editedAt: null,
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

describe('GET /api/v1/resparkable/comments', () => {
  it('returns the thread with a count', async () => {
    vi.mocked(listCommentsFor).mockResolvedValue([COMMENT]);

    const response = await invoke(
      COMMENTS_GET,
      req(`http://localhost/api/v1/resparkable/comments?entityType=project&entityId=${PROJECT_ID}`)
    );

    const body = await response.json();
    expect(body.meta.count).toBe(1);
  });

  it('404s when the basis carries no comments', async () => {
    vi.mocked(listCommentsFor).mockResolvedValue(null);

    const response = await invoke(
      COMMENTS_GET,
      req(`http://localhost/api/v1/resparkable/comments?entityType=project&entityId=${PROJECT_ID}`)
    );

    // A public link and a cascaded grant both read the item and neither reads
    // its thread. "There is a thread you may not see" would be a distinguishable
    // answer about somebody else's brain.
    expect(response.status).toBe(404);
  });

  it('builds the viewer from the session, lower-cased', async () => {
    vi.mocked(listCommentsFor).mockResolvedValue([]);

    await invoke(
      COMMENTS_GET,
      req(`http://localhost/api/v1/resparkable/comments?entityType=project&entityId=${PROJECT_ID}`)
    );

    expect(vi.mocked(listCommentsFor).mock.calls[0][0]).toEqual({
      userId: 'user_b',
      email: 'b@example.com',
    });
  });
});

describe('POST /api/v1/resparkable/comments', () => {
  it('creates a comment and returns 201 with the whole thread', async () => {
    vi.mocked(addComment).mockResolvedValue([COMMENT]);

    const response = await invoke(
      COMMENTS_POST,
      req('http://localhost/api/v1/resparkable/comments', {
        entityType: 'project',
        entityId: PROJECT_ID,
        body: 'Looks right to me',
      })
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data).toHaveLength(1);
  });

  it('gives a read-only grant the same 404 as a missing item', async () => {
    vi.mocked(addComment).mockResolvedValue(null);

    const response = await invoke(
      COMMENTS_POST,
      req('http://localhost/api/v1/resparkable/comments', {
        entityType: 'project',
        entityId: PROJECT_ID,
        body: 'hello',
      })
    );

    // "You may look but not speak" as a 403 would confirm the item exists.
    expect(response.status).toBe(404);
  });

  it('refuses to comment on a thought', async () => {
    const response = await invoke(
      COMMENTS_POST,
      req('http://localhost/api/v1/resparkable/comments', {
        entityType: 'thought',
        entityId: PROJECT_ID,
        body: 'hello',
      })
    );

    // The raw capture inbox is unshareable, so nothing there can be commented
    // on — refused at the schema, before any resolution.
    expect(response.status).toBe(400);
    expect(addComment).not.toHaveBeenCalled();
  });

  it('rejects an empty comment rather than storing whitespace', async () => {
    const response = await invoke(
      COMMENTS_POST,
      req('http://localhost/api/v1/resparkable/comments', {
        entityType: 'project',
        entityId: PROJECT_ID,
        body: '   ',
      })
    );

    expect(response.status).toBe(400);
  });

  it('never writes the comment body to a log line', async () => {
    vi.mocked(addComment).mockResolvedValue([COMMENT]);

    await invoke(
      COMMENTS_POST,
      req('http://localhost/api/v1/resparkable/comments', {
        entityType: 'project',
        entityId: PROJECT_ID,
        body: 'the merger closes on Tuesday',
      })
    );

    // Content, and a log line is the one place content most reliably outlives
    // the system that held it.
    expect(JSON.stringify(routeLog.info.mock.calls)).not.toContain('merger');
  });
});

describe('POST /api/v1/resparkable/grants/[id]/invite', () => {
  it('reports that an email was sent', async () => {
    vi.mocked(sendGrantInvite).mockResolvedValue('sent');

    const response = await invoke(
      INVITE_POST,
      req('http://localhost/api/v1/resparkable/grants/grant_1/invite'),
      { id: 'grant_1' }
    );

    expect((await response.json()).data).toEqual({ sent: true });
  });

  it('404s a revoked or missing grant, so revocation cannot be undone', async () => {
    vi.mocked(sendGrantInvite).mockResolvedValue('no_grant');

    const response = await invoke(
      INVITE_POST,
      req('http://localhost/api/v1/resparkable/grants/grant_1/invite'),
      { id: 'grant_1' }
    );

    expect(response.status).toBe(404);
  });

  it('reports a send failure as sent:false, not as an error', async () => {
    vi.mocked(sendGrantInvite).mockResolvedValue('send_failed');

    const response = await invoke(
      INVITE_POST,
      req('http://localhost/api/v1/resparkable/grants/grant_1/invite'),
      { id: 'grant_1' }
    );

    // The grant is already live for that address. A 500 would tell the owner
    // the share failed when what failed was the notification.
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ sent: false });
  });
});

describe('POST /api/v1/resparkable/invites/accept', () => {
  const TOKEN = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

  it('binds the account and names what to open', async () => {
    vi.mocked(acceptInvite).mockResolvedValue({
      ok: true,
      entityType: 'project',
      entityId: PROJECT_ID,
      alreadyAccepted: false,
    });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/invites/accept', { token: TOKEN })
    );

    expect((await response.json()).data).toMatchObject({
      accepted: true,
      entityType: 'project',
      entityId: PROJECT_ID,
    });
  });

  it('answers the wrong account with a 200 and a masked address', async () => {
    vi.mocked(acceptInvite).mockResolvedValue({
      ok: false,
      reason: 'wrong_account',
      expectedEmail: 'b***@e***.com',
    });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/invites/accept', { token: TOKEN })
    );

    // A state the page explains, not an error. And masked: the reader needs to
    // recognise their own mailbox, and a stranger holding a forwarded email
    // must not learn a working address (§16.3).
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.accepted).toBe(false);
    expect(body.data.expectedEmail).toBe('b***@e***.com');
    expect(JSON.stringify(body)).not.toContain('b@example.com');
  });

  it('404s unknown, revoked and expired alike', async () => {
    vi.mocked(acceptInvite).mockResolvedValue({ ok: false, reason: 'unknown' });

    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/invites/accept', { token: TOKEN })
    );

    expect(response.status).toBe(404);
  });

  it('rejects a malformed token before any lookup', async () => {
    const response = await invoke(
      ACCEPT_POST,
      req('http://localhost/api/v1/resparkable/invites/accept', { token: 'nope' })
    );

    expect(response.status).toBe(400);
    expect(acceptInvite).not.toHaveBeenCalled();
  });
});
