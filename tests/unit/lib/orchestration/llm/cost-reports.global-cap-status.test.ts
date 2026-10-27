/**
 * Unit tests for getGlobalCapStatus() in cost-reports.ts
 *
 * Test Coverage:
 * - No settings row → { cap: null, spent: 0, exceeded: false }
 * - Settings row with null cap → { cap: null, spent: 0, exceeded: false }
 * - Cap set, spend below cap → exceeded: false
 * - Cap set, spend meets cap → exceeded: true
 * - Cap set, spend exceeds cap → exceeded: true
 * - Prisma error → safe fallback { cap: null, spent: 0, exceeded: false }
 * - At multi, the every-org spend goes only to the install org (§110 t-788)
 *
 * @see lib/orchestration/llm/cost-reports.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forgetSpendCaps } from '@/lib/orchestration/llm/spend-caps';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockMode = vi.hoisted(() => ({ value: 'single' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    aiAgent: {
      findMany: vi.fn(),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { getGlobalCapStatus } = await import('@/lib/orchestration/llm/cost-reports');

const mockedSettingsFindUnique = prisma.aiOrchestrationSettings.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedAggregate = prisma.aiCostLog.aggregate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The month-to-date totals are cached across calls; each test starts cold.
  forgetSpendCaps();
  vi.resetAllMocks();
  mockMode.value = 'single';
});

describe('getGlobalCapStatus', () => {
  it('returns safe default when no settings row exists', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce(null);
    // The settings reader creates the singleton with no cap.
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValueOnce({
      globalMonthlyBudgetUsd: null,
    } as never);

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: null, spent: 0, exceeded: false });
    expect(mockedAggregate).not.toHaveBeenCalled();
  });

  it('returns safe default when settings row has null cap', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: null });

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: null, spent: 0, exceeded: false });
    expect(mockedAggregate).not.toHaveBeenCalled();
  });

  it('returns exceeded: false when spend is below cap', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
    mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 500 } });

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: 1000, spent: 500, exceeded: false });
  });

  it('returns exceeded: true when spend meets cap exactly', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
    mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 1000 } });

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: 1000, spent: 1000, exceeded: true });
  });

  it('returns exceeded: true when spend exceeds cap', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
    mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: 1500 } });

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: 1000, spent: 1500, exceeded: true });
  });

  it('treats null aggregate sum as zero spend', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 500 });
    mockedAggregate.mockResolvedValueOnce({ _sum: { totalCostUsd: null } });

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: 500, spent: 0, exceeded: false });
  });

  it('returns safe fallback on Prisma error (never throws)', async () => {
    mockedSettingsFindUnique.mockRejectedValueOnce(new Error('DB connection failed'));

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: null, spent: 0, exceeded: false });
  });

  it('returns safe fallback when aggregate call fails after settings succeeds', async () => {
    mockedSettingsFindUnique.mockResolvedValueOnce({ globalMonthlyBudgetUsd: 1000 });
    mockedAggregate.mockRejectedValueOnce(new Error('aggregate timeout'));

    const result = await getGlobalCapStatus();

    expect(result).toEqual({ cap: null, spent: 0, exceeded: false });
  });
});

describe('getGlobalCapStatus at multi', () => {
  beforeEach(() => {
    mockMode.value = 'multi';
    mockedSettingsFindUnique.mockResolvedValue({ globalMonthlyBudgetUsd: 100 });
    mockedAggregate.mockResolvedValue({ _sum: { totalCostUsd: 120 } });
    // The every-org total is read across orgs at multi.
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ total: 120 }]);
  });

  it("shows a customer org whether the cap is reached, but not every org's spend", async () => {
    const result = await runAsOrg('cmorg0000000000000000orgb', () => getGlobalCapStatus());

    expect(result).toEqual({ cap: 100, spent: null, exceeded: true });
  });

  it('shows the install org the spend, where the cap is set', async () => {
    const result = await runAsOrg(INSTALL_ORG_ID, () => getGlobalCapStatus());

    expect(result).toEqual({ cap: 100, spent: 120, exceeded: true });
  });
});
