/**
 * Tests: the global budget cap totals every org's spend at `multi` (§110 t-788).
 *
 * `checkBudget()` runs inside the guard's `runAsOrg`. At `multi` the
 * `org_isolation` policy then shows the aggregate only the acting org's
 * `AiCostLog` rows, so a total read in that scope is that org's total, and the
 * "global" cap becomes the same cap applied per org. The total has to be read
 * in the system scope instead: these tests record the scope each aggregate ran
 * in, and fail if it goes back to the acting org's.
 *
 * The policy itself is proven against Postgres by the two-org smoke
 * (`scripts/smoke/tenancy-isolation.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockMode = vi.hoisted(() => ({ value: 'multi' }));
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

const db = vi.hoisted(() => ({
  aiCostLog: { aggregate: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
  aiOrchestrationSettings: { findUnique: vi.fn() },
  org: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkBudget, getMonthToDateGlobalSpend } from '@/lib/orchestration/llm/cost-tracker';
import { forgetSpendCaps } from '@/lib/orchestration/llm/spend-caps';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';

const ORG_A = 'cmorg0000000000000000orga';

interface SeenAggregate {
  where: Record<string, unknown>;
  orgId: string | null | undefined;
  source: string | undefined;
}

let seen: SeenAggregate[];

beforeEach(() => {
  // The month-to-date totals are cached across calls; each test starts cold.
  forgetSpendCaps();
  vi.clearAllMocks();
  mockMode.value = 'multi';
  seen = [];
  db.aiCostLog.aggregate.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const ctx = getTenantContext();
    seen.push({ where: args.where, orgId: ctx?.orgId, source: ctx?.source });
    return { _sum: { totalCostUsd: 10 } };
  });
  db.aiAgent.findUnique.mockResolvedValue({ monthlyBudgetUsd: null, orgId: ORG_A });
  db.aiOrchestrationSettings.findUnique.mockResolvedValue({ globalMonthlyBudgetUsd: 100 });
  db.org.findUnique.mockResolvedValue({ settings: null });
});

/** The aggregates with no `agentId` or `orgId` filter: the install-wide total. */
function globalTotals(): SeenAggregate[] {
  return seen.filter((a) => !('agentId' in a.where) && !('orgId' in a.where));
}

describe('global spend at multi', () => {
  it('reads the month-to-date total in the system scope, not the acting org', async () => {
    await runAsOrg(ORG_A, () => getMonthToDateGlobalSpend());

    expect(globalTotals()).toHaveLength(1);
    expect(globalTotals()[0]).toMatchObject({ orgId: null, source: 'system' });
  });

  it("checkBudget's global cap reads the total in the system scope", async () => {
    await runAsOrg(ORG_A, () => checkBudget('agent-1'));

    // The agent's own aggregate stays in the acting org…
    const agentAggregate = seen.find((a) => 'agentId' in a.where);
    expect(agentAggregate).toMatchObject({ orgId: ORG_A });
    // …and the install-wide total does not.
    expect(globalTotals()).toHaveLength(1);
    expect(globalTotals()[0]).toMatchObject({ orgId: null, source: 'system' });
  });

  it('at single, reads the total as it is, entering no system scope', async () => {
    mockMode.value = 'single';

    await runAsOrg(ORG_A, () => getMonthToDateGlobalSpend());

    expect(globalTotals()).toHaveLength(1);
    expect(globalTotals()[0]).toMatchObject({ orgId: ORG_A });
  });
});
