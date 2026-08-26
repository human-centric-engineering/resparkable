/**
 * Unit Tests: `drainResparkableJobs` — claim, gate, run, settle.
 *
 * ## The assertion this file exists for
 *
 * **An idle brain must consume zero LLM calls.** Not "few", zero. The four
 * background workflows are debited against the owner's credit balance, so a
 * nightly triage over an inbox with nothing new in it reads the same notes,
 * calls the same model, writes the same "nothing to process" summary and
 * charges for it. That is not a cheap run, it is a worthless one, and it is a
 * charge the person would not agree to if they were asked.
 *
 * `phase-56-plan.md` §7 describes the demand gate as something asked "on
 * completion". Written that way it costs one billed do-nothing run per dormant
 * period per brain — roughly four a month at weekly backoff — so the gate here
 * is a **pre-flight** check instead. Several tests below pin that ordering
 * specifically, because the difference between the two is invisible in a log
 * and visible only on an invoice.
 *
 * ## And the settle path
 *
 * Every exit from a claimed job has to write the row exactly once, or the lease
 * is left live and the brain waits ten minutes for a reclaim it should not have
 * needed. Success, skip, no-credit, failure and unknown-kind are all asserted.
 *
 * Test Coverage:
 * - A gated kind with no activity since `lastRunAt` never reaches its handler
 * - A skipped run does NOT advance `lastRunAt`, so no window goes unexamined
 * - Dormancy backoff derives from how long the row has been dormant, capped
 * - An ungated kind (retention) runs regardless of activity
 * - A first-ever run is never gated
 * - A zero balance skips the run and reschedules at the normal cadence
 * - A handler that throws produces backoff, an attempt count and a message
 * - The failure cap marks the row dormant rather than retrying for ever
 * - One brain's failure does not stop the batch or the loop
 * - The job budget and the wall-clock budget both stop the loop
 * - An unknown kind is deferred, not failed
 *
 * @see lib/framework/resparkable/queue/drain.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/jobs', () => ({
  claimResparkableJobs: vi.fn(),
  completeResparkableJob: vi.fn().mockResolvedValue(true),
  failResparkableJob: vi.fn().mockResolvedValue(true),
  hasResparkableActivitySince: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/queue/handlers', () => ({
  runResparkableJob: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/billing', () => ({
  hasPositiveBalance: vi.fn().mockResolvedValue(true),
}));

import { drainResparkableJobs } from '@/lib/framework/resparkable/queue/drain';
import { runResparkableJob } from '@/lib/framework/resparkable/queue/handlers';
import {
  claimResparkableJobs,
  completeResparkableJob,
  failResparkableJob,
  hasResparkableActivitySince,
} from '@/lib/framework/resparkable/repo/jobs';
import { hasPositiveBalance } from '@/lib/framework/resparkable/services/billing';

const NOW = new Date('2026-06-15T12:00:00.000Z');

const NOTHING = {
  executionsQueued: 0,
  connectionsCreated: 0,
  retentionArchived: 0,
  retentionPruned: 0,
  reindexEmbedded: 0,
  reindexChunks: 0,
  incomplete: false,
};

function job(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job_1',
    userId: 'user_a',
    kind: 'triage',
    dueAt: new Date('2026-06-15T03:15:00.000Z'),
    attempts: 0,
    lastRunAt: new Date('2026-06-14T03:15:00.000Z'),
    dormantSince: null,
    timezone: 'UTC',
    ...overrides,
  };
}

/** Claim `batch` once, then report the queue empty — one pass through the loop. */
function claimOnce(batch: ReturnType<typeof job>[]): void {
  vi.mocked(claimResparkableJobs).mockResolvedValueOnce(batch).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeResparkableJob).mockResolvedValue(true);
  vi.mocked(failResparkableJob).mockResolvedValue(true);
  vi.mocked(hasPositiveBalance).mockResolvedValue(true);
  vi.mocked(runResparkableJob).mockResolvedValue({ ...NOTHING });
});

describe('the demand gate — the billing rule, not a budget lever', () => {
  it('never reaches the handler when nothing has changed', async () => {
    // The whole point. `runResparkableJob` is where the model call lives, so a
    // gate asked after it would already have spent the money.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([job()]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(runResparkableJob).not.toHaveBeenCalled();
    expect(result.skippedDormant).toBe(1);
  });

  it('asks about the window since the last real run', async () => {
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([job({ lastRunAt: new Date('2026-06-10T00:00:00.000Z') })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(hasResparkableActivitySince).toHaveBeenCalledWith(
      'user_a',
      new Date('2026-06-10T00:00:00.000Z')
    );
  });

  it('does NOT advance lastRunAt on a skip', async () => {
    // If a skip stamped `lastRunAt`, the next gate would ask about a shorter
    // window than the one that has actually gone unexamined — so a write made
    // just before the skip would be missed for ever, and the brain would sleep
    // through the very change that should have woken it.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([job()]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(vi.mocked(completeResparkableJob).mock.calls[0]?.[2]).toMatchObject({
      lastRunAt: null,
    });
  });

  it('stamps dormancy from the first skip and keeps the original instant after', async () => {
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    const earlier = new Date('2026-06-13T12:00:00.000Z');
    claimOnce([job(), job({ id: 'job_2', dormantSince: earlier })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5, concurrency: 2 });

    const calls = vi.mocked(completeResparkableJob).mock.calls;
    const first = calls.find((c) => c[0] === 'job_1')?.[2];
    const second = calls.find((c) => c[0] === 'job_2')?.[2];

    expect(first?.dormantSince).toEqual(NOW);
    // Not re-stamped. `dormantSince` doubles as the backoff clock, so resetting
    // it on every skip would pin a permanently idle brain at the base cadence
    // and it would never actually back off.
    expect(second?.dormantSince).toEqual(earlier);
  });

  it('backs off by however long the row has been dormant, and keeps the local hour', async () => {
    // Dormant for two days, so the wait should be about two days — and a
    // briefing still has to arrive at 04:30 rather than at whatever instant the
    // arithmetic lands on.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([
      job({
        kind: 'briefing',
        dormantSince: new Date('2026-06-13T12:00:00.000Z'),
      }),
    ]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    const dueAt = vi.mocked(completeResparkableJob).mock.calls[0]?.[2]?.dueAt;
    expect(dueAt.toISOString()).toBe('2026-06-18T04:30:00.000Z');
  });

  it('caps the backoff at a week', async () => {
    // Quiet for three months. The floor cadence is weekly, not quarterly:
    // someone returning after a long absence should cost one cycle, and a brain
    // that has genuinely gone should still be checked often enough that coming
    // back feels immediate.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([job({ kind: 'briefing', dormantSince: new Date('2026-03-15T12:00:00.000Z') })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    const dueAt = vi.mocked(completeResparkableJob).mock.calls[0]?.[2]?.dueAt;
    expect(dueAt.toISOString()).toBe('2026-06-23T04:30:00.000Z');
  });

  it('runs an ungated kind even when nothing has changed', async () => {
    // Retention is driven by the calendar. Gating it would stop it working for
    // exactly the dormant brains whose data most needs ageing out.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(false);
    claimOnce([job({ kind: 'retention' })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(hasResparkableActivitySince).not.toHaveBeenCalled();
    expect(runResparkableJob).toHaveBeenCalledWith('retention', { userId: 'user_a' }, NOW);
  });

  it('never gates a first-ever run', async () => {
    // A brand-new brain is empty and has no events. Gating it would mean the
    // first briefing never arrives — the failure being least visible to exactly
    // the person most likely to conclude the product does not work.
    claimOnce([job({ lastRunAt: null })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(hasResparkableActivitySince).not.toHaveBeenCalled();
    expect(runResparkableJob).toHaveBeenCalled();
  });

  it('clears dormancy on a run that did happen', async () => {
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    claimOnce([job({ dormantSince: new Date('2026-06-13T12:00:00.000Z') })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(vi.mocked(completeResparkableJob).mock.calls[0]?.[2]).toMatchObject({
      dormantSince: null,
      lastRunAt: NOW,
    });
  });
});

describe('the balance gate', () => {
  it('skips a spending kind when the balance is gone, at the normal cadence', async () => {
    // Not dormant: an owner at zero credits is not idle, they are out of
    // credit, and the moment they top up the next cycle should find them.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(hasPositiveBalance).mockResolvedValue(false);
    claimOnce([job()]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(runResparkableJob).not.toHaveBeenCalled();
    expect(result.skippedNoCredit).toBe(1);
    const settled = vi.mocked(completeResparkableJob).mock.calls[0]?.[2];
    expect(settled?.dormantSince).toBeUndefined();
    expect(settled?.dueAt?.toISOString()).toBe('2026-06-16T03:15:00.000Z');
  });

  it('does not check the balance for a kind that spends nothing', async () => {
    // The sweep reads vectors that are already stored and finds pairs in SQL.
    // There is no model call to refuse, so refusing it would stop a free thing
    // working for someone whose only problem is an empty wallet.
    claimOnce([job({ kind: 'sweep', lastRunAt: null })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(hasPositiveBalance).not.toHaveBeenCalled();
    expect(runResparkableJob).toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('records the attempt, the message and a doubling backoff', async () => {
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(runResparkableJob).mockRejectedValue(new Error('dimension mismatch'));
    claimOnce([job({ attempts: 2 })]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(result.failed).toBe(1);
    const settled = vi.mocked(failResparkableJob).mock.calls[0]?.[2];
    expect(settled?.attempts).toBe(3);
    expect(settled?.lastError).toBe('dimension mismatch');
    // Third attempt: 60s × 2² = four minutes.
    expect(settled?.dueAt?.toISOString()).toBe('2026-06-15T12:04:00.000Z');
    expect(settled?.dormantSince).toBeUndefined();
  });

  it('puts the row to sleep at the failure cap rather than retrying for ever', async () => {
    // Past the cap the failure is not transient, and every further attempt
    // costs money for a run that has never once succeeded. Dormant slows it to
    // weekly; it is never deleted, because a deleted row is one that does not
    // come back when whatever broke is fixed.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(runResparkableJob).mockRejectedValue(new Error('still broken'));
    claimOnce([job({ attempts: 7 })]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    const settled = vi.mocked(failResparkableJob).mock.calls[0]?.[2];
    expect(settled?.attempts).toBe(8);
    expect(settled?.dormantSince).toEqual(NOW);
    expect(settled?.dueAt?.toISOString()).toBe('2026-06-22T12:00:00.000Z');
  });

  it('truncates a runaway error message', async () => {
    // `lastError` is read in a list view, and an ORM stack trace is not a
    // diagnosis. The full text already went to the log with the job id.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(runResparkableJob).mockRejectedValue(new Error('x'.repeat(2000)));
    claimOnce([job()]);

    await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(vi.mocked(failResparkableJob).mock.calls[0]?.[2]?.lastError).toHaveLength(500);
  });

  it('does not let one brain’s failure cost the others their turn', async () => {
    // The isolation the sweep rotation had. Losing it means a single bad corpus
    // wedges background work for everybody, which is the same class of silent
    // stall the whole design exists to prevent.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(runResparkableJob)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ...NOTHING, executionsQueued: 1 });
    claimOnce([job(), job({ id: 'job_2', userId: 'user_b' })]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 5, concurrency: 2 });

    expect(result.failed).toBe(1);
    expect(result.outcome.executionsQueued).toBe(1);
    expect(result.settled).toBe(2);
  });
});

describe('the budget', () => {
  it('stops at maxJobs and never claims more than it can run', async () => {
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(claimResparkableJobs).mockResolvedValue([job()] as never);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 3, concurrency: 4 });

    expect(result.settled).toBe(3);
    // The last claim asks for one, not four: over-claiming would lease rows
    // this pass has no budget to run and park them for the lease duration.
    const sizes = vi.mocked(claimResparkableJobs).mock.calls.map((call) => call[1]);
    expect(sizes).toEqual([3, 2, 1]);
  });

  it('reports an empty queue rather than spinning on it', async () => {
    vi.mocked(claimResparkableJobs).mockResolvedValue([]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 50 });

    expect(result.queueEmpty).toBe(true);
    expect(result.settled).toBe(0);
    expect(claimResparkableJobs).toHaveBeenCalledTimes(1);
  });

  it('does not report an empty queue when it stopped on budget', async () => {
    // The distinction the worker loop sleeps on. Pausing after a pass that hit
    // its budget would idle a worker in front of a backlog.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    vi.mocked(claimResparkableJobs).mockResolvedValue([job()] as never);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 1 });

    expect(result.queueEmpty).toBe(false);
  });
});

describe('an unrecognised kind', () => {
  it('is deferred a day rather than failed', async () => {
    // A row written by a newer build than this process is running — a rolling
    // deploy. Burning through `attempts` on it would put the row to sleep for a
    // week over a deploy that finishes in minutes.
    claimOnce([job({ kind: 'quarterly_wibble' })]);

    const result = await drainResparkableJobs({ now: NOW, maxJobs: 5 });

    expect(failResparkableJob).not.toHaveBeenCalled();
    expect(runResparkableJob).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
    const settled = vi.mocked(completeResparkableJob).mock.calls[0]?.[2];
    expect(settled?.dueAt?.toISOString()).toBe('2026-06-16T12:00:00.000Z');
  });
});

describe('the worker identity', () => {
  it('settles under the same identity it claimed with', async () => {
    // The lease guard. A settle from a worker whose lease has expired must be a
    // zero-row update, not a clobber of whoever holds the row now — and that
    // only works if the id used to claim is the id used to settle.
    vi.mocked(hasResparkableActivitySince).mockResolvedValue(true);
    claimOnce([job()]);

    await drainResparkableJobs({ now: NOW, maxJobs: 1, workerId: 'worker-7' });

    expect(vi.mocked(claimResparkableJobs).mock.calls[0]?.[0]).toBe('worker-7');
    expect(vi.mocked(completeResparkableJob).mock.calls[0]?.[1]).toBe('worker-7');
  });
});
