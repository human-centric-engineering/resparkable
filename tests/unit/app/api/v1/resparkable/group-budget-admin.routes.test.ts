/**
 * Unit Tests: the group budget admin routes (§23.12, phase 50).
 *
 * `group-budget.routes.test.ts` covers test 13k, the pre-flight refusing a
 * spend before it happens. This file is the other half: the three routes an
 * admin (or a member, for the top-up) uses to read and change a group's
 * budget: `GET`/`PATCH .../budget`, `POST .../budget/top-up` and
 * `PATCH .../budget/members/[userId]`.
 *
 * What is worth pinning at the route layer, the same lens
 * `groups.routes.test.ts` applies:
 *
 *   - Every `BudgetRefusal` maps to the status `budget-refusal.ts` documents:
 *     `not_a_member`/`no_such_member` 404, `not_an_admin`/`top_up_not_allowed`
 *     403, `insufficient_personal_credits` 402.
 *   - The strict Zod schemas reject an empty body, unknown keys and
 *     out-of-range values before the service is ever called.
 *   - A successful call returns the service's value under `data`.
 *
 * The service's own decisions (who may top up, the admin-only split, the
 * alerts) are covered by `services/group-budget.test.ts` and are not
 * re-tested here.
 *
 * @see app/api/v1/resparkable/groups/[id]/budget/route.ts
 * @see app/api/v1/resparkable/groups/[id]/budget/top-up/route.ts
 * @see app/api/v1/resparkable/groups/[id]/budget/members/[userId]/route.ts
 * @see lib/framework/resparkable/api/budget-refusal.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

vi.mock('@/lib/framework/resparkable/services/group-budget', () => ({
  getGroupBudget: vi.fn(),
  updateGroupBudgetSettings: vi.fn(),
  topUpGroup: vi.fn(),
  setMemberDailyCreditCap: vi.fn(),
}));

import {
  GET as BUDGET_GET,
  PATCH as BUDGET_PATCH,
} from '@/app/api/v1/resparkable/groups/[id]/budget/route';
import { POST as TOP_UP_POST } from '@/app/api/v1/resparkable/groups/[id]/budget/top-up/route';
import { PATCH as MEMBER_CAP_PATCH } from '@/app/api/v1/resparkable/groups/[id]/budget/members/[userId]/route';
import {
  getGroupBudget,
  setMemberDailyCreditCap,
  topUpGroup,
  updateGroupBudgetSettings,
} from '@/lib/framework/resparkable/services/group-budget';

const SESSION = { user: { id: 'user_a', email: 'a@example.com' }, session: { userId: 'user_a' } };
const GROUP_ID = 'grp_1';

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
  params: Record<string, string>
): Promise<Response> {
  const fn = handler as (request: unknown, session: unknown, context: unknown) => Promise<Response>;
  return fn(request, SESSION, { params: Promise.resolve(params) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const REFUSAL_STATUS: Record<string, number> = {
  not_a_member: 404,
  no_such_member: 404,
  not_an_admin: 403,
  top_up_not_allowed: 403,
  insufficient_personal_credits: 402,
};

describe('GET /api/v1/resparkable/groups/[id]/budget', () => {
  it('is a 404, not a 403, for a group the caller is not a member of', async () => {
    vi.mocked(getGroupBudget).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      BUDGET_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('returns the budget view under data', async () => {
    const view = {
      balanceCredits: 40,
      fundingMode: 'self_funded' as const,
      canTopUp: false,
      yourPersonalBalanceCredits: 12,
      you: { dailyCreditCap: null, spentLastDayCredits: 0 },
      admin: null,
    };
    vi.mocked(getGroupBudget).mockResolvedValue({ ok: true, value: view });

    const response = await invoke(
      BUDGET_GET,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(view);
  });

  it('resolves the budget for the session user and the group id in the path', async () => {
    vi.mocked(getGroupBudget).mockResolvedValue({
      ok: true,
      value: {
        balanceCredits: 0,
        fundingMode: 'self_funded',
        canTopUp: false,
        yourPersonalBalanceCredits: 0,
        you: { dailyCreditCap: null, spentLastDayCredits: 0 },
        admin: null,
      },
    });

    await invoke(BUDGET_GET, req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`), {
      id: GROUP_ID,
    });

    expect(getGroupBudget).toHaveBeenCalledWith('user_a', GROUP_ID);
  });
});

describe('PATCH /api/v1/resparkable/groups/[id]/budget', () => {
  it('rejects an empty body, rather than reaching the service', async () => {
    const response = await invoke(
      BUDGET_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {}),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(updateGroupBudgetSettings).not.toHaveBeenCalled();
  });

  it('rejects an unknown key, rather than reaching the service', async () => {
    const response = await invoke(
      BUDGET_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {
        fundingMode: 'self_funded',
        somethingElse: true,
      }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(updateGroupBudgetSettings).not.toHaveBeenCalled();
  });

  it('rejects a largeRunAlertPercent outside 1..100', async () => {
    const tooLow = await invoke(
      BUDGET_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {
        largeRunAlertPercent: 0,
      }),
      { id: GROUP_ID }
    );
    const tooHigh = await invoke(
      BUDGET_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {
        largeRunAlertPercent: 101,
      }),
      { id: GROUP_ID }
    );

    expect(tooLow.status).toBe(400);
    expect(tooHigh.status).toBe(400);
    expect(updateGroupBudgetSettings).not.toHaveBeenCalled();
  });

  for (const [reason, status] of Object.entries(REFUSAL_STATUS)) {
    if (reason === 'no_such_member' || reason === 'top_up_not_allowed') continue;
    it(`maps '${reason}' to ${status}`, async () => {
      vi.mocked(updateGroupBudgetSettings).mockResolvedValue({
        ok: false,
        reason: reason as never,
      });

      const response = await invoke(
        BUDGET_PATCH,
        req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {
          fundingMode: 'self_funded',
        }),
        { id: GROUP_ID }
      );

      expect(response.status).toBe(status);
    });
  }

  it('applies a valid update and returns the new settings', async () => {
    vi.mocked(updateGroupBudgetSettings).mockResolvedValue({
      ok: true,
      value: {
        fundingMode: 'member_contributions',
        lowBalanceAlertCredits: 10,
        largeRunAlertPercent: 50,
      },
    });

    const response = await invoke(
      BUDGET_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget`, {
        fundingMode: 'member_contributions',
      }),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      fundingMode: 'member_contributions',
      lowBalanceAlertCredits: 10,
      largeRunAlertPercent: 50,
    });
  });
});

describe('POST /api/v1/resparkable/groups/[id]/budget/top-up', () => {
  it('rejects zero credits, rather than reaching the service', async () => {
    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: 0 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(topUpGroup).not.toHaveBeenCalled();
  });

  it('rejects negative credits, rather than reaching the service', async () => {
    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: -5 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(400);
    expect(topUpGroup).not.toHaveBeenCalled();
  });

  it('is a 403 top_up_not_allowed for a member in a self-funded group', async () => {
    vi.mocked(topUpGroup).mockResolvedValue({ ok: false, reason: 'top_up_not_allowed' });

    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: 10 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(403);
  });

  it('is a 402 when the giver’s own balance does not cover it', async () => {
    vi.mocked(topUpGroup).mockResolvedValue({ ok: false, reason: 'insufficient_personal_credits' });

    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: 10 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(402);
  });

  it('is a 404, not a 403, when the caller is not a member', async () => {
    vi.mocked(topUpGroup).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: 10 }),
      { id: GROUP_ID }
    );

    expect(response.status).toBe(404);
  });

  it('tops up and returns the new balance', async () => {
    vi.mocked(topUpGroup).mockResolvedValue({ ok: true, value: { balanceCredits: 60 } });

    const response = await invoke(
      TOP_UP_POST,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/top-up`, { credits: 10 }),
      { id: GROUP_ID }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ balanceCredits: 60 });
    expect(topUpGroup).toHaveBeenCalledWith('user_a', GROUP_ID, 10);
  });
});

describe('PATCH /api/v1/resparkable/groups/[id]/budget/members/[userId]', () => {
  it('accepts a null dailyCreditCap, which clears the cap', async () => {
    vi.mocked(setMemberDailyCreditCap).mockResolvedValue({
      ok: true,
      value: { userId: 'user_b', dailyCreditCap: null },
    });

    const response = await invoke(
      MEMBER_CAP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/members/user_b`, {
        dailyCreditCap: null,
      }),
      { id: GROUP_ID, userId: 'user_b' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ userId: 'user_b', dailyCreditCap: null });
  });

  it('rejects a missing dailyCreditCap field, rather than reaching the service', async () => {
    const response = await invoke(
      MEMBER_CAP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/members/user_b`, {}),
      { id: GROUP_ID, userId: 'user_b' }
    );

    expect(response.status).toBe(400);
    expect(setMemberDailyCreditCap).not.toHaveBeenCalled();
  });

  it('is a 403 when the caller is a member but not an admin', async () => {
    vi.mocked(setMemberDailyCreditCap).mockResolvedValue({ ok: false, reason: 'not_an_admin' });

    const response = await invoke(
      MEMBER_CAP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/members/user_b`, {
        dailyCreditCap: 5,
      }),
      { id: GROUP_ID, userId: 'user_b' }
    );

    expect(response.status).toBe(403);
  });

  it('is a 404 for a target who is not a member of this group', async () => {
    vi.mocked(setMemberDailyCreditCap).mockResolvedValue({ ok: false, reason: 'no_such_member' });

    const response = await invoke(
      MEMBER_CAP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/members/user_ghost`, {
        dailyCreditCap: 5,
      }),
      { id: GROUP_ID, userId: 'user_ghost' }
    );

    expect(response.status).toBe(404);
  });

  it('sets the cap and passes the target id from the path, not the body', async () => {
    vi.mocked(setMemberDailyCreditCap).mockResolvedValue({
      ok: true,
      value: { userId: 'user_b', dailyCreditCap: 5 },
    });

    const response = await invoke(
      MEMBER_CAP_PATCH,
      req(`http://localhost/api/v1/resparkable/groups/${GROUP_ID}/budget/members/user_b`, {
        dailyCreditCap: 5,
      }),
      { id: GROUP_ID, userId: 'user_b' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ userId: 'user_b', dailyCreditCap: 5 });
    expect(setMemberDailyCreditCap).toHaveBeenCalledWith('user_a', GROUP_ID, 'user_b', 5);
  });
});
