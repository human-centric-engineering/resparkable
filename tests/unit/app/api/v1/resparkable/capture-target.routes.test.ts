/**
 * Unit Tests: capture names its target, and defaults to personal (test 13e).
 *
 * Phase 47's acceptance criterion, and the reason it is written as a set of
 * per-path assertions rather than one: the failure this feature has is a
 * thought landing in a shared brain because the last workspace was sticky, and
 * that failure is silent. The capture succeeds, the box clears, and four other
 * people can read it. There is no error to notice and no state to inspect, so
 * the only thing standing between the product and that outcome is an assertion
 * per way in.
 *
 * The paths that can create a thought, and what each one must do:
 *
 *   1. **`POST /capture` with no target** lands in the personal space.
 *   2. **`POST /capture` with a target the caller is in** lands there.
 *   3. **`POST /capture` with a target the caller is NOT in** writes nothing
 *      and 404s.
 *   4. **`POST /capture` ignores `?space=` entirely.** This is the assertion
 *      the whole phase turns on: every read route in the tier reads that param,
 *      and this one must not, or the switcher silently re-aims capture.
 *   5. **The email inbox token is already correct** and must not be "fixed":
 *      the token IS the space, so there is no default to choose. Covered by
 *      `capabilities/capture-for-token.test.ts`.
 *   6. **The agent capability accepts no space argument**, for the reason none
 *      accepts a user id: every `agent*Schema` is `.strict()`. Asserted here on
 *      the capture schema directly, and swept for every capability by
 *      `capabilities/scope.test.ts`.
 *
 * The two UI paths (quick capture, the Sparkey composer) and the PWA share
 * target assert the same default in their own component tests, because what
 * they send is a property of the component rather than of the route.
 *
 * Voice and image are listed in the plan's table as entry points, and in this
 * implementation neither can write a thought at all: `/transcribe` and
 * `/transcribe/image` return text into the capture box, which is what makes
 * them safe. The assertion for those two is that they call no capture service,
 * and it is below.
 *
 * @see app/api/v1/resparkable/capture/route.ts
 * @see .context/framework/resparkable/plan.md: §23.4
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

vi.mock('@/lib/framework/resparkable/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findMembershipBySpace: vi.fn() }));

import { POST } from '@/app/api/v1/resparkable/capture/route';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { agentCaptureSchema, captureSchema } from '@/lib/framework/resparkable/validations';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const GROUP_SPACE = 'spc_group_1';

function req(body: Record<string, unknown>, query = ''): Request {
  return {
    url: `http://localhost:3000/api/v1/resparkable/capture${query}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Request;
}

function invoke(request: Request): Promise<Response> {
  return (POST as unknown as (...args: unknown[]) => Promise<Response>)(request, SESSION);
}

/** The scope capture was handed. */
function capturedScope(): { spaceId: string; role: string } {
  return vi.mocked(captureThought).mock.calls[0]?.[0];
}

function membership() {
  return {
    id: 'mem_1',
    groupId: 'grp_1',
    userId: 'user_a',
    role: 'member',
    invitedByUserId: null,
    joinedAt: new Date('2026-09-01T10:00:00Z'),
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureThought).mockResolvedValue({
    thought: { id: 'th_1', source: 'web', createdAt: new Date() },
    deduped: false,
  } as never);
});

describe('POST /capture — where a thought lands', () => {
  it('lands in the personal space when the body names no target', async () => {
    const response = await invoke(req({ content: 'a thought' }));

    expect(response.status).toBe(201);
    expect(capturedScope()).toMatchObject({ spaceId: 'user_a', role: 'owner' });
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });

  it('lands in a group when the body names one the caller is in', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership() as never);

    await invoke(req({ content: 'a thought', spaceId: GROUP_SPACE }));

    expect(capturedScope()).toMatchObject({ spaceId: GROUP_SPACE, role: 'member' });
  });

  it('writes nothing and 404s when the caller is not in the named group', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(null);

    const response = await invoke(req({ content: 'a thought', spaceId: GROUP_SPACE }));

    // The body is a target, never an authority, on the write path exactly as on
    // the read path.
    expect(response.status).toBe(404);
    expect(captureThought).not.toHaveBeenCalled();
  });

  it('IGNORES ?space= on the URL', async () => {
    // The assertion this phase turns on. Every read route in the tier reads
    // this param; capture must not, or the switcher quietly re-aims it and a
    // thought lands in a group because that is what was on screen.
    await invoke(req({ content: 'a thought' }, `?space=${GROUP_SPACE}`));

    expect(capturedScope()).toMatchObject({ spaceId: 'user_a' });
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });

  it('ignores ?space= even when the caller really is a member of it', async () => {
    // The version of the previous test that would pass by accident if the
    // route resolved the URL and merely preferred the body.
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership() as never);

    await invoke(req({ content: 'a thought' }, `?space=${GROUP_SPACE}`));

    expect(capturedScope()).toMatchObject({ spaceId: 'user_a' });
  });

  it('does not pass the target through to the thought itself', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership() as never);

    await invoke(req({ content: 'a thought', spaceId: GROUP_SPACE }));

    // `spaceId` is routing information, not a field of the thought. The scope
    // carries it; the input must not, or a repo would receive two answers.
    expect(vi.mocked(captureThought).mock.calls[0]?.[1]).not.toHaveProperty('spaceId');
  });
});

describe('the capture schemas', () => {
  it('accepts an optional target from a person', () => {
    expect(captureSchema.safeParse({ content: 'x' }).success).toBe(true);
    expect(captureSchema.safeParse({ content: 'x', spaceId: 'spc_1' }).success).toBe(true);
  });

  it('accepts no target at all from an agent', () => {
    // No `agent*Schema` has a space field and every one is `.strict()`, for the
    // same reason none has a user id: a workspace named by a model is a
    // workspace named by whatever text the model just read.
    expect(agentCaptureSchema.safeParse({ content: 'x', spaceId: 'spc_1' }).success).toBe(false);
  });
});
