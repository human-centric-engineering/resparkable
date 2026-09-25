/**
 * Unit Tests: `GET /api/v1/resparkable/briefing` and `POST .../regenerate`.
 *
 * The read route's specification is a **negative**: it makes no LLM call, ever.
 * The briefing is written overnight by `resparkable-morning-briefing` and this
 * serves the stored row, which is the whole reason §6 chose pre-computation
 * over generate-on-click. A regression that made this generate would look
 * identical in the response body and cost a model call on every dashboard load.
 * So the assertion is that the read path touches only the stored-briefing
 * service and never the queue.
 *
 * The regenerate route's job is to queue, not to run. It writes a `PENDING`
 * execution for the maintenance tick rather than invoking the engine inline —
 * re-implementing the scheduler's version resolution and budget handling in a
 * request handler would give the briefing its own private copy of the
 * platform's execution semantics, and the copy would drift.
 *
 * Two things it must not do, both asserted: pass a client-supplied user id
 * (the owner comes from the verified session), and accept a work style outside
 * the enum (the deterministic selection is only safe because the value is
 * closed).
 *
 * @see app/api/v1/resparkable/briefing/route.ts
 * @see app/api/v1/resparkable/briefing/regenerate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

vi.mock('@/lib/framework/resparkable/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  BRIEFING_HORIZON: 'briefing',
}));
vi.mock('@/lib/framework/resparkable/repo/workflow-runs', () => ({
  queueResparkableWorkflowRun: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/space', () => ({
  ensureResparkableSpace: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/billing', () => ({
  assertCanSpend: vi.fn(),
}));
// The real resolver: a null target is the personal space, which is the whole
// behaviour this route depends on and so the part worth not mocking.
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findMembershipBySpace: vi.fn() }));

import { GET } from '@/app/api/v1/resparkable/briefing/route';
import { POST } from '@/app/api/v1/resparkable/briefing/regenerate/route';
import { getStoredBriefing } from '@/lib/framework/resparkable/services/briefing';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { assertCanSpend } from '@/lib/framework/resparkable/services/billing';
import { InsufficientCreditsError } from '@/lib/api/errors';

const mockedStored = vi.mocked(getStoredBriefing);
const mockedQueue = vi.mocked(queueResparkableWorkflowRun);
const mockedEnsureSpace = vi.mocked(ensureResparkableSpace);

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

/**
 * The route handlers are wrapped by `withAuth`, whose exported type is the
 * single-argument Next signature — the mock above passes `(request, session,
 * context)` through. Casting at the call site is this repo's existing
 * convention for route tests; see `promote.routes.test.ts`.
 */
type RouteHandler = (...args: unknown[]) => Promise<Response>;
const getBriefing = GET as unknown as RouteHandler;
const postRegenerate = POST as unknown as RouteHandler;
const ISO = new Date('2026-08-04T03:15:00.000Z');

function get(): Request {
  return new Request('http://localhost/api/v1/resparkable/briefing');
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/v1/resparkable/briefing/regenerate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStored.mockResolvedValue({ review: null, stale: true, ageHours: null });
  mockedQueue.mockResolvedValue('exec_1');
  mockedEnsureSpace.mockResolvedValue(undefined as never);
});

describe('GET /resparkable/briefing', () => {
  it('serves the stored briefing without queueing anything', async () => {
    mockedStored.mockResolvedValue({
      review: {
        id: 'b1',
        title: 'Tuesday',
        body: 'You finished three things.',
        generatedAt: ISO,
      } as never,
      stale: false,
      ageHours: 6,
    });

    const response = await getBriefing(get(), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.briefing).toMatchObject({ id: 'b1', title: 'Tuesday' });
    expect(json.data.stale).toBe(false);
    // The whole design — reading is free.
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('scopes the read to the session user', async () => {
    await getBriefing(get(), SESSION_A, undefined);

    expect(mockedStored.mock.calls[0]?.[0]).toMatchObject({ spaceId: 'user_a' });
  });

  it('reports "no briefing yet" as data, not as an error', async () => {
    const response = await getBriefing(get(), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.briefing).toBeNull();
    expect(json.data.stale).toBe(true);
  });
});

describe('POST /resparkable/briefing/regenerate', () => {
  it('queues the briefing workflow for the session user', async () => {
    const response = await postRegenerate(post({}), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ executionId: 'exec_1', status: 'queued' });

    const [slug, scope] = mockedQueue.mock.calls[0] ?? [];
    expect(slug).toBe('resparkable-morning-briefing');
    expect(scope).toMatchObject({ spaceId: 'user_a', actorUserId: 'user_a', role: 'owner' });
  });

  it('refuses before queueing when the balance cannot pay, and queues nothing', async () => {
    // Phase 50: the pre-flight moved to the request. Until then this path queued
    // regardless and the budget failure arrived later in the run history.
    vi.mocked(assertCanSpend).mockRejectedValueOnce(new InsufficientCreditsError());

    const response = await postRegenerate(post({}), SESSION_A, undefined);

    expect(response.status).toBe(402);
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('regenerates the personal briefing even from a group workspace URL', async () => {
    // A group has no briefing. `?space=` is ignored here rather than resolved,
    // so a member in a group cannot queue their briefing against the group.
    const request = new Request(
      'http://localhost/api/v1/resparkable/briefing/regenerate?space=spc_group',
      { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } }
    );
    await postRegenerate(request, SESSION_A, undefined);

    expect(mockedQueue.mock.calls[0]?.[1]).toMatchObject({ spaceId: 'user_a' });
  });

  /**
   * REGRESSION. A `ResparkableCreditAccount` for the queued execution's owner
   * gets created (and billed) by `jobs.ts`'s tick, and its FK targets
   * `ResparkableSpace.userId` — a user whose very first Resparkable
   * interaction is this route would otherwise queue a run the tick job can
   * never bill (FK violation), repeating every tick until it ages out.
   */
  it('bootstraps the caller’s space before queuing, so a first-ever call can be billed later', async () => {
    await postRegenerate(post({}), SESSION_A, undefined);

    expect(ensureResparkableSpace).toHaveBeenCalledWith('user_a');
  });

  it('passes the override through as workflow input', async () => {
    await postRegenerate(post({ workStyleOverride: 'exploratory' }), SESSION_A, undefined);

    expect(mockedQueue.mock.calls[0]?.[2]).toEqual({ workStyleOverride: 'exploratory' });
  });

  it('sends no override when none was asked for', async () => {
    await postRegenerate(post({}), SESSION_A, undefined);

    expect(mockedQueue.mock.calls[0]?.[2]).toEqual({});
  });

  it('takes the owner from the session, never from the body', async () => {
    const response = await postRegenerate(post({ userId: 'user_b' }), SESSION_A, undefined);

    // `.strict()` — an injected userId is a validation error, not a silently
    // dropped key that leaves the caller thinking it worked.
    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('rejects a work style outside the enum', async () => {
    const response = await postRegenerate(
      post({ workStyleOverride: 'zen-mode' }),
      SESSION_A,
      undefined
    );

    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('reports 503 when the workflow has no published version', async () => {
    // The seeds have not run. Nothing is broken; something is not set up — and
    // the difference matters to whoever reads the logs.
    mockedQueue.mockResolvedValue(null);

    const response = await postRegenerate(post({}), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error.code).toBe('WORKFLOW_UNAVAILABLE');
  });
});
