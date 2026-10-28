/**
 * Unit Tests: GET /api/v1/admin/orchestration/costs/orgs (§110 t-790)
 *
 * Real `withAdminAuth`, real tenant context. The answer is every org's
 * spend, so at `multi` only the install org may read it: a platform admin
 * switched into a customer's org is refused, an org's own OWNER never reaches
 * the handler, and an unbound admin API key acts as the install org. At
 * `single` the rule has nothing to separate. The rollup itself is mocked at
 * its module; `cost-reports.org-usage.test.ts` covers it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockResolveApiKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  resolveApiKey: mockResolveApiKey,
}));

const mockMembership = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: { orgMembership: { findUnique: mockMembership } },
}));

const mockGetOrgUsage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/cost-reports', () => ({ getOrgUsage: mockGetOrgUsage }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET } from '@/app/api/v1/admin/orchestration/costs/orgs/route';

const CUSTOMER = 'cmorg000000000000000other';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  return {
    session: {
      id: 'session_1',
      userId: 'cmjbv4i3x00003wsloputgwul',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId,
    },
    user: {
      id: 'cmjbv4i3x00003wsloputgwul',
      name: 'Admin',
      email: 'admin@example.com',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

/** Sign in as `role`, switched into `org` and holding `orgRole` there. */
function signedIn(role: 'USER' | 'ADMIN', org: string, orgRole: string = ORG_OWNER_ROLE) {
  mockGetSession.mockResolvedValue(session(role, org));
  mockMembership.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

const get = (query = '') =>
  GET(
    new Request(
      `http://localhost/api/v1/admin/orchestration/costs/orgs${query}`
    ) as unknown as NextRequest
  );

const REPORT = {
  period: '2026-10',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  orgs: [],
  detached: null,
  totals: { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockResolveApiKey.mockResolvedValue(null);
  mockGetOrgUsage.mockResolvedValue(REPORT);
});

describe('GET /api/v1/admin/orchestration/costs/orgs at multi', () => {
  it('refuses a platform admin switched into a customer org, reading nothing', async () => {
    signedIn('ADMIN', CUSTOMER);

    const res = await get();
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
    expect(body.error.message).toMatch(/install organisation/);
    expect(mockGetOrgUsage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the read
    expect(mockLog.warn).toHaveBeenCalledWith(
      'tenancy: refused the per-org usage read outside the install org',
      expect.objectContaining({ activeOrgId: CUSTOMER })
    );
  });

  it('refuses a customer-org admin even when asking only for their own org', async () => {
    signedIn('ADMIN', CUSTOMER);

    const res = await get(`?orgId=${CUSTOMER}`);

    expect(res.status).toBe(403);
    expect(mockGetOrgUsage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the read
  });

  it("refuses an org's own OWNER who is not a platform admin", async () => {
    signedIn('USER', CUSTOMER, ORG_OWNER_ROLE);

    const res = await get();

    expect(res.status).toBe(403);
    expect(mockGetOrgUsage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused by the guard
  });

  it('answers a platform admin in the install org, for the requested month', async () => {
    signedIn('ADMIN', INSTALL_ORG_ID);

    const res = await get('?period=2026-09');
    const body = (await res.json()) as { success: boolean; data: unknown };

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: REPORT });
    expect(mockGetOrgUsage).toHaveBeenCalledWith({ period: '2026-09' });
  });

  it('defaults the period to the current UTC month and passes an org filter through', async () => {
    signedIn('ADMIN', INSTALL_ORG_ID);

    const res = await get(`?orgId=${CUSTOMER}`);

    expect(res.status).toBe(200);
    expect(mockGetOrgUsage).toHaveBeenCalledWith({
      period: new Date().toISOString().slice(0, 7),
      orgId: CUSTOMER,
    });
  });

  it('lets an unbound admin API key read it, as the install org', async () => {
    mockGetSession.mockResolvedValue(null);
    mockResolveApiKey.mockResolvedValue({
      session: session('ADMIN', null),
      scopes: ['admin'],
      rateLimitRpm: null,
      orgId: null,
      ownerAccountType: 'HUMAN',
    });

    const res = await get();

    expect(res.status).toBe(200);
    expect(mockGetOrgUsage).toHaveBeenCalledTimes(1);
  });

  it.each(['2026-13', '2026-1', 'October', '2026-10-01', '0050-03', '0000-01'])(
    'rejects a period that is not a YYYY-MM month (%s)',
    async (period) => {
      signedIn('ADMIN', INSTALL_ORG_ID);

      const res = await get(`?period=${period}`);

      expect(res.status).toBe(400);
      expect(mockGetOrgUsage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — rejected by validation
    }
  );
});

describe('GET /api/v1/admin/orchestration/costs/orgs at single', () => {
  it('answers a platform admin, whatever org the session names', async () => {
    mockEnv.TENANCY_MODE = 'single';
    signedIn('ADMIN', INSTALL_ORG_ID);

    const res = await get();

    expect(res.status).toBe(200);
    expect(mockGetOrgUsage).toHaveBeenCalledTimes(1);
  });
});
