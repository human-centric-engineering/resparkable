/**
 * Unit Tests: `POST /api/v1/resparkable/reviews/[id]/dismiss`.
 *
 * Thin route — build a scope, call `dismissReview`, and turn a `null` into a
 * 404. Like every other cross-user lookup in this tier, another user's review
 * id must be indistinguishable from a typo: `dismissReview` returns `null` for
 * both and this route must answer 404, never 403 (§16.2 — a 403 would confirm
 * the row exists).
 *
 * @see app/api/v1/resparkable/reviews/[id]/dismiss/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResparkableReview } from '@prisma/client';

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

vi.mock('@/lib/framework/resparkable/services/reviews', () => ({ dismissReview: vi.fn() }));

import { POST } from '@/app/api/v1/resparkable/reviews/[id]/dismiss/route';
import { dismissReview } from '@/lib/framework/resparkable/services/reviews';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedDismiss = vi.mocked(dismissReview);

const REVIEW = {
  id: 'review_1',
  horizon: 'weekly',
  title: 'Week 31',
  body: 'Three things moved.',
} as ResparkableReview;

function req(url = 'http://localhost:3000/api/v1/resparkable/reviews/review_1/dismiss'): Request {
  return {
    url,
    json: async () => undefined,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(id = 'review_1'): Promise<Response> {
  return (POST as unknown as (...args: unknown[]) => Promise<Response>)(req(), SESSION_A, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDismiss.mockResolvedValue(REVIEW);
});

describe('POST /api/v1/resparkable/reviews/[id]/dismiss', () => {
  it('dismisses the review and returns it in the response envelope', async () => {
    const response = await invoke();
    const body = (await response.json()) as { success: boolean; data: unknown };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(REVIEW);
  });

  it('scopes to the session user and passes the route id through, never anything from the request', async () => {
    await invoke('review_1');

    const [scope, id] = mockedDismiss.mock.calls[0] ?? [];
    expect((scope as { userId: string }).userId).toBe('user_a');
    expect(id).toBe('review_1');
  });

  it('returns 404 — not 403 — for a review that is not the caller’s', async () => {
    mockedDismiss.mockResolvedValue(null);

    const response = await invoke('review_someone_else');

    // A 403 would confirm the row exists. Missing and not-yours must look the same.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
  });
});
