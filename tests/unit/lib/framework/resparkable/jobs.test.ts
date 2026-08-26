/**
 * Unit Tests: the maintenance tick — bill, repair, drain.
 *
 * ## The regression this file is mostly about
 *
 * The billing pass used to fetch the **newest 100** terminal executions, on the
 * argument that a fresh completion is always in the top 100 rows so newest-first
 * is self-correcting without a cursor column. That holds for one completion at a
 * time and fails in exactly the case that matters. If more than a hundred
 * executions reach a terminal state between two passes — a hundred and fifty
 * nightly triages finishing inside one window, which is a hundred and fifty
 * users, not a hundred and fifty thousand — the oldest fall off the bottom and
 * are **never billed at all**. Nothing errors. The platform eats the cost of the
 * runs it lost, silently, and the effect grows with the install.
 *
 * The candidate set is now an anti-join against the ledger, so an execution
 * leaves it the moment it is billed and the set only ever shrinks. `limit`
 * survives as a per-pass bound rather than as a window: rows this pass does not
 * reach are still candidates on the next one.
 *
 * ## And the composition
 *
 * The tick does three things in a fixed order and none of them may cost the
 * others their turn. Billing is not per-user work and runs regardless of
 * `RESPARKABLE_WORKER_MODE`; the backfill net is caught separately so a brain
 * missing its rows costs one more tick rather than the whole drain.
 *
 * Test Coverage:
 * - Billing runs even when the tick is not draining
 * - Every unbilled execution is attributed and debited
 * - A system-owned legacy row is billed through its scope key
 * - An unattributable execution is skipped, not billed to somebody
 * - A duplicate ledger write is swallowed, not logged as an error
 * - One failed ledger write does not stop the rest of the batch
 * - A failing backfill does not stop the drain
 *
 * @see lib/framework/resparkable/jobs.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  findUnbilledTerminalResparkableExecutions: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/billing', () => ({
  recordAgentSpend: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/queue/drain', () => ({
  drainResparkableJobs: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/queue/enqueue', () => ({
  backfillMissingResparkableJobs: vi.fn(),
}));

import { runResparkableTick } from '@/lib/framework/resparkable/jobs';
import { drainResparkableJobs } from '@/lib/framework/resparkable/queue/drain';
import { backfillMissingResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';
import { findUnbilledTerminalResparkableExecutions } from '@/lib/framework/resparkable/repo/billing';
import { RESPARKABLE_SCHEDULE_OWNER_KEY } from '@/lib/framework/resparkable/repo/owner-scope';
import { recordAgentSpend } from '@/lib/framework/resparkable/services/billing';
import { RESPARKABLE_SCHEDULED_WORKFLOWS } from '@/lib/framework/resparkable/workflows/slugs';
import { WorkflowStatus } from '@/types/orchestration';

const EMPTY_DRAIN = {
  settled: 0,
  skippedDormant: 0,
  skippedNoCredit: 0,
  failed: 0,
  queueEmpty: true,
  outcome: {
    executionsQueued: 0,
    connectionsCreated: 0,
    retentionArchived: 0,
    retentionPruned: 0,
    reindexEmbedded: 0,
    reindexChunks: 0,
    incomplete: false,
  },
};

function execution(overrides: Record<string, unknown> = {}) {
  return { id: 'exec_1', userId: 'user_a', scope: null, totalCostUsd: 0.12, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([]);
  vi.mocked(backfillMissingResparkableJobs).mockResolvedValue(0);
  vi.mocked(drainResparkableJobs).mockResolvedValue({ ...EMPTY_DRAIN });
  vi.mocked(recordAgentSpend).mockResolvedValue({ id: 'ledger_1' } as never);
});

describe('the billing pass', () => {
  it('asks for the unbilled set, not the newest N', async () => {
    // The whole point. A window loses rows under a spike; an anti-join cannot.
    await runResparkableTick();

    const [slugs, statuses, limit] = vi.mocked(findUnbilledTerminalResparkableExecutions).mock
      .calls[0];

    expect(slugs).toEqual(expect.arrayContaining(Object.values(RESPARKABLE_SCHEDULED_WORKFLOWS)));
    expect(statuses).toEqual(
      expect.arrayContaining([
        WorkflowStatus.COMPLETED,
        WorkflowStatus.FAILED,
        WorkflowStatus.CANCELLED,
      ])
    );
    expect(limit).toBeGreaterThan(0);
  });

  it('bills a failed run as well as a completed one', async () => {
    // A run that failed halfway still spent whatever it spent getting there.
    // Billing only completions would leave that cost with the platform.
    await runResparkableTick();
    const statuses = vi.mocked(findUnbilledTerminalResparkableExecutions).mock.calls[0]?.[1];
    expect(statuses).toContain(WorkflowStatus.FAILED);
  });

  it('debits the real cost against the execution’s owner', async () => {
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([execution()] as never);

    const result = await runResparkableTick();

    expect(recordAgentSpend).toHaveBeenCalledWith(
      { userId: 'user_a' },
      { tokenCostUsd: 0.12, relatedWorkflowExecutionId: 'exec_1' }
    );
    expect(result.executionsBilled).toBe(1);
  });

  it('bills a legacy system-owned run through its scope key', async () => {
    // Executions fired by the platform scheduler before the cutover are
    // `userId: null` and carry the owner in `scope` (resparkable#502). Nothing
    // creates those any more, but the ones already in the table still have to
    // be billed rather than dropped.
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([
      execution({ userId: null, scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'user_b' } }),
    ] as never);

    await runResparkableTick();

    expect(vi.mocked(recordAgentSpend).mock.calls[0]?.[0]).toEqual({ userId: 'user_b' });
  });

  it('skips an execution it cannot attribute rather than billing somebody', async () => {
    // An org-level run, or a Resparkable-slug row written by something outside
    // this tier. Guessing an owner here debits a real person for a run that was
    // not theirs.
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([
      execution({ userId: null, scope: { somethingElse: 'user_b' } }),
    ] as never);

    const result = await runResparkableTick();

    expect(recordAgentSpend).not.toHaveBeenCalled();
    expect(result.executionsSkipped).toBe(1);
    expect(result.executionsBilled).toBe(0);
  });

  it('treats a malformed scope as unattributable', async () => {
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([
      execution({ userId: null, scope: 'user_b' }),
      execution({ id: 'exec_2', userId: null, scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: 42 } }),
    ] as never);

    const result = await runResparkableTick();

    expect(result.executionsSkipped).toBe(2);
  });

  it('swallows a duplicate ledger write instead of logging an error', async () => {
    // Two workers racing the same execution collide on
    // `@@unique([kind, relatedWorkflowExecutionId])`. That is the constraint
    // doing its job, not a fault.
    const duplicate = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    vi.mocked(recordAgentSpend).mockRejectedValue(duplicate);
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([execution()] as never);

    const result = await runResparkableTick();

    expect(result.executionsBilled).toBe(0);
    expect(result.executionsSkipped).toBe(0);
  });

  it('does not let one bad ledger write cost the rest of the batch', async () => {
    vi.mocked(recordAgentSpend)
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValue({ id: 'ledger_2' } as never);
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([
      execution(),
      execution({ id: 'exec_2', userId: 'user_b' }),
    ] as never);

    const result = await runResparkableTick();

    expect(result.executionsBilled).toBe(1);
  });

  it('runs even when this process is not draining', async () => {
    // Billing is not per-user work and does not belong to any worker. On an
    // install with `RESPARKABLE_WORKER_MODE=external` the web containers still
    // have to do it, or nobody does.
    vi.mocked(findUnbilledTerminalResparkableExecutions).mockResolvedValue([execution()] as never);

    const result = await runResparkableTick({ drain: false });

    expect(result.executionsBilled).toBe(1);
    expect(drainResparkableJobs).not.toHaveBeenCalled();
  });
});

describe('composition', () => {
  it('drains with a budget that fits inside a 60-second tick', async () => {
    await runResparkableTick();

    const budget = vi.mocked(drainResparkableJobs).mock.calls[0]?.[0];
    expect(budget?.maxJobs).toBeGreaterThan(0);
    expect(budget?.maxWallClockMs).toBeLessThan(60_000);
  });

  it('does not let a failing backfill cost the drain its turn', async () => {
    // The net under the enqueue. A brain missing its rows stays missing for one
    // more tick, which is the same order of delay the net already tolerates —
    // and far better than skipping everyone else's background work over it.
    vi.mocked(backfillMissingResparkableJobs).mockRejectedValue(new Error('deadlock'));

    const result = await runResparkableTick();

    expect(result.jobsBackfilled).toBe(0);
    expect(drainResparkableJobs).toHaveBeenCalledTimes(1);
  });

  it('reports the drain’s counters alongside its own', async () => {
    vi.mocked(drainResparkableJobs).mockResolvedValue({
      ...EMPTY_DRAIN,
      settled: 4,
      skippedDormant: 2,
      queueEmpty: false,
      outcome: { ...EMPTY_DRAIN.outcome, executionsQueued: 2 },
    });
    vi.mocked(backfillMissingResparkableJobs).mockResolvedValue(7);

    const result = await runResparkableTick();

    expect(result).toMatchObject({
      settled: 4,
      skippedDormant: 2,
      jobsBackfilled: 7,
      executionsBilled: 0,
    });
    expect(result.outcome.executionsQueued).toBe(2);
  });
});
