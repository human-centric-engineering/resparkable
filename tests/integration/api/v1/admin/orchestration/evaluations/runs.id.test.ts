/**
 * Integration Test: Admin Orchestration — Single Run (detail)
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id
 *
 * @see app/api/v1/admin/orchestration/evaluations/runs/[id]/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 / 400 on auth + CUID validation
 * - 404 when run belongs to another user (ownership scoping)
 * - happy path returns run with includes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/evaluations/runs/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationRun: { findFirst: vi.fn() },
    aiDataset: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const RUN_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';
const DATASET = { id: 'd', name: 'Dataset', caseCount: 3, contentHash: 'h' };

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    userId: ADMIN_ID,
    name: 'My Run',
    status: 'running',
    progress: { casesTotal: 3, casesDone: 1, casesFailed: 0 },
    agent: { id: 'a', name: 'Agent', slug: 'agent' },
    workflow: null,
    datasetId: 'd',
    _count: { results: 1 },
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(id: string): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/admin/orchestration/evaluations/runs/${id}`);
  return new NextRequest(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/runs/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(403);
  });

  it('returns 400 when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest(INVALID_ID), makeParams(INVALID_ID));

    expect(response.status).toBe(400);
  });

  it('returns 404 when run belongs to another user (cross-user scoping)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiEvaluationRun.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: RUN_ID, userId: ADMIN_ID }),
      })
    );
  });

  it('returns 200 with the run and its dataset on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(makeRunRow() as never);
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(DATASET as never);

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: {
        id: string;
        status: string;
        agent: { id: string };
        dataset: typeof DATASET | null;
        _count: { results: number };
      };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe(RUN_ID);
    expect(data.data.status).toBe('running');
    expect(data.data._count.results).toBe(1);
    expect(data.data.dataset).toEqual(DATASET);
    // The dataset is not included on the run: read on its own, so a dataset
    // that changed hands cannot refuse the whole read (§115).
    const runArgs = vi.mocked(prisma.aiEvaluationRun.findFirst).mock.calls[0][0];
    expect(runArgs?.include).not.toHaveProperty('dataset');
    expect(vi.mocked(prisma.aiDataset.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        // Theirs, or one nobody owns — this admin's policy admits orphans.
        where: { AND: [{ OR: [{ userId: ADMIN_ID }, { userId: null }] }, { id: 'd' }] },
      })
    );
  });

  it("still returns the caller's run when its dataset is no longer theirs", async () => {
    // An orphan dataset the run used, since claimed by another admin: the
    // visibility read finds nothing, and the run comes back with no dataset.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findFirst).mockResolvedValue(makeRunRow() as never);
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await GET(makeGetRequest(RUN_ID), makeParams(RUN_ID));

    expect(response.status).toBe(200);
    const data = await parseJson<{ data: { id: string; dataset: unknown } }>(response);
    expect(data.data.id).toBe(RUN_ID);
    expect(data.data.dataset).toBeNull();
  });
});
