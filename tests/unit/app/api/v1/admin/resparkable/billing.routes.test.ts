/**
 * Unit Tests: the three admin billing routes added in phase 29 —
 * GET/PATCH `/api/v1/admin/resparkable/billing/settings`,
 * GET `/api/v1/admin/resparkable/billing/accounts`,
 * POST `/api/v1/admin/resparkable/billing/grants`.
 *
 * Same shape as `admin-settings.routes.test.ts`: admin-guarded, singleton-backed
 * settings with resolved defaults on `GET`, plus two cross-user admin repo calls
 * that are mocked here rather than exercised against a real database.
 *
 * The grants suite's sharpest test is the one pinning `grantCreditsAsAdmin`'s
 * fourth argument to `session.user.id` rather than anything from the request
 * body — the schema has no field for "who is granting", so the only source of
 * truth is the session the route wrapper already verified. A route bug that
 * let the body supply that value would let one admin forge a grant recorded
 * under another admin's name.
 *
 * @see app/api/v1/admin/resparkable/billing/settings/route.ts
 * @see app/api/v1/admin/resparkable/billing/accounts/route.ts
 * @see app/api/v1/admin/resparkable/billing/grants/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResparkableBillingSettings, ResparkableCreditLedgerEntry } from '@prisma/client';

vi.mock('@/lib/auth/guards', () => {
  const wrap =
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    };
  return {
    withAuth: vi.fn(wrap),
    withAdminAuth: vi.fn(wrap),
  };
});

vi.mock('@/lib/framework/resparkable/repo/billing-settings', () => ({
  findResparkableBillingSettings: vi.fn(),
  upsertResparkableBillingSettings: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  listCreditAccountsForAdmin: vi.fn(),
  grantCreditsAsAdmin: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/space', () => ({
  ensureResparkableSpace: vi.fn(),
}));

import {
  GET as SETTINGS_GET,
  PATCH as SETTINGS_PATCH,
} from '@/app/api/v1/admin/resparkable/billing/settings/route';
import { GET as ACCOUNTS_GET } from '@/app/api/v1/admin/resparkable/billing/accounts/route';
import { POST as GRANTS_POST } from '@/app/api/v1/admin/resparkable/billing/grants/route';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth, withAuth } from '@/lib/auth/guards';
import {
  findResparkableBillingSettings,
  upsertResparkableBillingSettings,
} from '@/lib/framework/resparkable/repo/billing-settings';
import {
  listCreditAccountsForAdmin,
  grantCreditsAsAdmin,
} from '@/lib/framework/resparkable/repo/billing';
import { DEFAULT_BILLING_SETTINGS } from '@/lib/framework/resparkable/settings';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';

// Captured immediately after import, above — `export const GET =
// withAdminAuth(handler)` runs once at module-eval time, before any
// `beforeEach` hook clears mock call history. All three routes in this file
// share one module-eval pass, so one capture covers all of them.
const usedAdminAuthAtLoad = vi.mocked(withAdminAuth).mock.calls.length > 0;
const usedPlainAuthAtLoad = vi.mocked(withAuth).mock.calls.length > 0;

const ADMIN_SESSION = { user: { id: 'admin_1', role: 'ADMIN' }, session: { userId: 'admin_1' } };

function getReq(url: string) {
  return {
    url: `http://localhost:3000${url}`,
    headers: new Headers(),
  } as unknown as Request;
}

function postReq(url: string, body: unknown) {
  return {
    url: `http://localhost:3000${url}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Request;
}

function invoke(handler: unknown, request: unknown, session: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session);
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function billingSettingsRow(
  overrides: Partial<ResparkableBillingSettings> = {}
): ResparkableBillingSettings {
  return {
    id: 'billing_settings_1',
    slug: 'global',
    creditsPerUsd: 2,
    serviceChargePercent: 10,
    costVisibleToUsersDefault: false,
    currencyLabel: 'sparks',
    newUserGrantCredits: 50,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function ledgerEntry(
  overrides: Partial<ResparkableCreditLedgerEntry> = {}
): ResparkableCreditLedgerEntry {
  return {
    id: 'ledger_1',
    spaceId: 'user_a',
    createdByUserId: null,
    kind: 'admin_grant',
    creditsDelta: 100,
    tokenCostUsd: null,
    serviceChargeUsd: null,
    totalUsd: null,
    relatedConversationId: null,
    relatedWorkflowExecutionId: null,
    relatedCostLogId: null,
    note: null,
    createdByAdminId: 'admin_1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(ensureResparkableSpace).mockResolvedValue(undefined as never);
});

it('all three routes are guarded by withAdminAuth, not withAuth', () => {
  expect(usedAdminAuthAtLoad).toBe(true);
  expect(usedPlainAuthAtLoad).toBe(false);
});

describe('GET /api/v1/admin/resparkable/billing/settings', () => {
  it('reports the code defaults, isDefault: true, when no row has ever been saved', async () => {
    vi.mocked(findResparkableBillingSettings).mockResolvedValue(null);

    const response = await invoke(
      SETTINGS_GET,
      getReq('/api/v1/admin/resparkable/billing/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ ...DEFAULT_BILLING_SETTINGS, isDefault: true });
  });

  it('resolves a stored row over the code defaults, isDefault: false', async () => {
    vi.mocked(findResparkableBillingSettings).mockResolvedValue(
      billingSettingsRow({ creditsPerUsd: 5, serviceChargePercent: 25 })
    );

    const response = await invoke(
      SETTINGS_GET,
      getReq('/api/v1/admin/resparkable/billing/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data).toMatchObject({
      creditsPerUsd: 5,
      serviceChargePercent: 25,
      isDefault: false,
    });
  });
});

describe('PATCH /api/v1/admin/resparkable/billing/settings', () => {
  it('persists only the fields that were actually supplied', async () => {
    vi.mocked(upsertResparkableBillingSettings).mockResolvedValue(
      billingSettingsRow({ creditsPerUsd: 3 })
    );

    const response = await invoke(
      SETTINGS_PATCH,
      postReq('/api/v1/admin/resparkable/billing/settings', { creditsPerUsd: 3 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(upsertResparkableBillingSettings).toHaveBeenCalledWith({ creditsPerUsd: 3 });
  });

  it('rejects a non-positive creditsPerUsd', async () => {
    const response = await invoke(
      SETTINGS_PATCH,
      postReq('/api/v1/admin/resparkable/billing/settings', { creditsPerUsd: -1 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertResparkableBillingSettings).not.toHaveBeenCalled();
  });

  it('rejects an unknown field — the schema is .partial().strict()', async () => {
    const response = await invoke(
      SETTINGS_PATCH,
      postReq('/api/v1/admin/resparkable/billing/settings', { creditsPerUsd: 3, notARealField: 1 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertResparkableBillingSettings).not.toHaveBeenCalled();
  });

  it('always reports isDefault: false, even immediately after a first save', async () => {
    vi.mocked(upsertResparkableBillingSettings).mockResolvedValue(
      billingSettingsRow({ creditsPerUsd: 1, serviceChargePercent: 0 })
    );

    const response = await invoke(
      SETTINGS_PATCH,
      postReq('/api/v1/admin/resparkable/billing/settings', { creditsPerUsd: 1 }),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.isDefault).toBe(false);
  });
});

describe('GET /api/v1/admin/resparkable/billing/accounts', () => {
  it('passes the cursor query param through to listCreditAccountsForAdmin', async () => {
    vi.mocked(listCreditAccountsForAdmin).mockResolvedValue([]);

    await invoke(
      ACCOUNTS_GET,
      getReq('/api/v1/admin/resparkable/billing/accounts?cursor=user_5'),
      ADMIN_SESSION
    );

    expect(listCreditAccountsForAdmin).toHaveBeenCalledWith({ cursor: 'user_5' });
  });

  it('omits cursor from the call when the query param is absent', async () => {
    vi.mocked(listCreditAccountsForAdmin).mockResolvedValue([]);

    await invoke(ACCOUNTS_GET, getReq('/api/v1/admin/resparkable/billing/accounts'), ADMIN_SESSION);

    expect(listCreditAccountsForAdmin).toHaveBeenCalledWith({ cursor: undefined });
  });

  it('rejects an empty cursor rather than forwarding it unvalidated', async () => {
    const response = await invoke(
      ACCOUNTS_GET,
      getReq('/api/v1/admin/resparkable/billing/accounts?cursor='),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(listCreditAccountsForAdmin).not.toHaveBeenCalled();
  });

  it('returns the accounts array wrapped in the response envelope', async () => {
    const rows = [
      { userId: 'user_a', balanceCredits: 40, userName: 'A', userEmail: 'a@example.com' },
      { userId: 'user_b', balanceCredits: 0, userName: null, userEmail: 'b@example.com' },
    ];
    vi.mocked(listCreditAccountsForAdmin).mockResolvedValue(rows);

    const response = await invoke(
      ACCOUNTS_GET,
      getReq('/api/v1/admin/resparkable/billing/accounts'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ accounts: rows });
  });
});

describe('POST /api/v1/admin/resparkable/billing/grants', () => {
  it('rejects a zero amount — the schema refinement forbids no-op grants', async () => {
    const response = await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', { userId: 'user_a', amount: 0 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(grantCreditsAsAdmin).not.toHaveBeenCalled();
  });

  it('rejects a missing userId', async () => {
    const response = await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', { amount: 100 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(grantCreditsAsAdmin).not.toHaveBeenCalled();
  });

  it('rejects an unknown extra body field — the schema is .strict()', async () => {
    const response = await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', {
        userId: 'user_a',
        amount: 100,
        adminId: 'admin_2',
      }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(grantCreditsAsAdmin).not.toHaveBeenCalled();
  });

  it('accepts a negative amount as a valid correction', async () => {
    vi.mocked(grantCreditsAsAdmin).mockResolvedValue(ledgerEntry({ creditsDelta: -25 }));

    const response = await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', {
        userId: 'user_a',
        amount: -25,
        note: 'correction',
      }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(grantCreditsAsAdmin).toHaveBeenCalledWith('user_a', -25, 'correction', 'admin_1');
  });

  it("calls grantCreditsAsAdmin with the admin's own session id, not anything from the request body", async () => {
    // This is the security-critical assertion: the grant schema has no field
    // for who is granting, so the only legitimate source for the fourth
    // argument is the verified session. A route bug that read an admin id out
    // of the body would let a caller forge which admin gets credited.
    vi.mocked(grantCreditsAsAdmin).mockResolvedValue(ledgerEntry());

    await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', { userId: 'user_a', amount: 100 }),
      { user: { id: 'admin_real', role: 'ADMIN' }, session: { userId: 'admin_real' } }
    );

    expect(grantCreditsAsAdmin).toHaveBeenCalledWith('user_a', 100, undefined, 'admin_real');
  });

  /**
   * REGRESSION. `ResparkableCreditAccount.userId` FKs against
   * `ResparkableSpace.userId`, not `User.id` — a target user who has never
   * opened Resparkable has no space row yet, and `grantCreditsAsAdmin`'s own
   * account-creation would throw a raw FK violation for exactly the
   * "brand-new user" case this route's doc comment claims works.
   */
  it('bootstraps the target user’s space before granting, so a brand-new user works', async () => {
    const order: string[] = [];
    vi.mocked(ensureResparkableSpace).mockImplementation(() => {
      order.push('ensureResparkableSpace');
      return Promise.resolve(undefined as never);
    });
    vi.mocked(grantCreditsAsAdmin).mockImplementation(() => {
      order.push('grantCreditsAsAdmin');
      return Promise.resolve(ledgerEntry());
    });

    await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', { userId: 'user_new', amount: 10 }),
      ADMIN_SESSION
    );

    expect(ensureResparkableSpace).toHaveBeenCalledWith('user_new');
    expect(order).toEqual(['ensureResparkableSpace', 'grantCreditsAsAdmin']);
  });

  it('returns the created ledger entry wrapped in the response envelope', async () => {
    const entry = ledgerEntry({ id: 'ledger_9', creditsDelta: 250 });
    vi.mocked(grantCreditsAsAdmin).mockResolvedValue(entry);

    const response = await invoke(
      GRANTS_POST,
      postReq('/api/v1/admin/resparkable/billing/grants', { userId: 'user_a', amount: 250 }),
      ADMIN_SESSION
    );
    const body = await response.json();

    // Compared field-by-field rather than `toEqual({ entry })`: `entry.createdAt`
    // is a `Date`, but the route's response goes through `Response.json`, which
    // serialises it to an ISO string — a whole-object `toEqual` against the
    // original `Date` would fail on that round trip alone.
    expect(response.status).toBe(200);
    expect(body.data.entry).toMatchObject({
      id: 'ledger_9',
      spaceId: 'user_a',
      kind: 'admin_grant',
      creditsDelta: 250,
    });
  });
});
