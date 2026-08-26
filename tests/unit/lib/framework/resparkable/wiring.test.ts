/**
 * Unit Tests: the tick registration, and the two briefing capabilities.
 *
 * ## Why the registration gets its own test
 *
 * A registration that silently does not happen is the worst failure shape in
 * this tier, because nothing about it is visible: the job just never runs, and
 * that looks exactly like "there was nothing to do". Phase 6 already lost a day
 * to the Turbopack version of this (resparkable#462), which is why capabilities
 * and context contributors are wired through lazily-initialised `lib/app/*`
 * seams rather than at boot.
 *
 * **The erasure hook that used to be tested here is gone**, and its absence is
 * the phase-56 result worth stating: the hook existed only because
 * `AiWorkflowSchedule.createdBy` is `onDelete: SetNull`, so an erased person's
 * schedules survived them and kept firing. There are no schedule rows any more.
 * `ResparkableJob` hangs off `ResparkableSpace` like every other satellite
 * table, so erasure is the D1 cascade — one FK, no code, and nothing that can
 * fail to be registered.
 *
 * ## And the two briefing capabilities
 *
 * Covered by the cross-capability sweeps (`scope.test.ts`, `catalogue.test.ts`)
 * but with no behaviour test of their own, which left their `run()` bodies
 * unexercised. The interesting one is `resparkable_get_briefing`: it must serialise
 * the stored row and, in particular, must **not** generate anything.
 *
 * @see lib/framework/resparkable/jobs.ts
 * @see lib/framework/resparkable/capabilities/briefing.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  buildBriefingInputs: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  findUnbilledTerminalResparkableExecutions: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/framework/resparkable/queue/enqueue', () => ({
  backfillMissingResparkableJobs: vi.fn().mockResolvedValue(0),
}));
vi.mock('@/lib/framework/resparkable/queue/drain', () => ({
  drainResparkableJobs: vi.fn(),
}));

import {
  registerResparkableJobs,
  RESPARKABLE_QUEUE_JOB_NAME,
} from '@/lib/framework/resparkable/jobs';
import {
  ResparkableGetBriefingCapability,
  ResparkableGetBriefingInputsCapability,
} from '@/lib/framework/resparkable/capabilities/briefing';
import { drainResparkableJobs } from '@/lib/framework/resparkable/queue/drain';
import {
  getStoredBriefing,
  buildBriefingInputs,
} from '@/lib/framework/resparkable/services/briefing';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const CONTEXT: CapabilityContext = { userId: 'user_a', agentId: 'agent_1' };
const ISO = new Date('2026-08-04T03:15:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerResparkableJobs', () => {
  beforeEach(() => {
    __resetAppJobsForTests();
    delete process.env.RESPARKABLE_WORKER_MODE;
    vi.mocked(drainResparkableJobs).mockResolvedValue({
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
    });
  });

  it('registers exactly the queue job, with a positive interval', () => {
    registerResparkableJobs();

    const jobs = getAppJobs().filter((job) => job.name === RESPARKABLE_QUEUE_JOB_NAME);
    expect(jobs).toHaveLength(1);
    // `registerAppJob` refuses a non-positive interval outright, so a zero here
    // would silently drop the job rather than run it constantly.
    expect(jobs[0]?.intervalMs).toBeGreaterThan(0);
  });

  it('is idempotent under a repeated call', () => {
    registerResparkableJobs();
    registerResparkableJobs();

    expect(getAppJobs().filter((job) => job.name === RESPARKABLE_QUEUE_JOB_NAME)).toHaveLength(1);
  });

  it('registers a run() that actually drains', async () => {
    // The closure is the part that runs at 3am with nobody watching; a job
    // registered with a body that throws on its first call would look identical
    // to one that works until the tick fires.
    registerResparkableJobs();

    const job = getAppJobs().find((j) => j.name === RESPARKABLE_QUEUE_JOB_NAME);
    await expect(job?.run()).resolves.toMatchObject({ settled: 0, executionsBilled: 0 });
    expect(drainResparkableJobs).toHaveBeenCalledTimes(1);
  });

  it('stops draining from the tick when the worker mode is external', async () => {
    // The knob a scaled install sets on its WEB containers, so the standalone
    // workers have the queue to themselves. Billing must still happen — it is
    // not per-user work and does not belong to any worker.
    process.env.RESPARKABLE_WORKER_MODE = 'external';
    registerResparkableJobs();

    const job = getAppJobs().find((j) => j.name === RESPARKABLE_QUEUE_JOB_NAME);
    await expect(job?.run()).resolves.toMatchObject({ settled: 0, queueEmpty: true });
    expect(drainResparkableJobs).not.toHaveBeenCalled();
  });

  it('still drains when the mode is a typo', async () => {
    // The failure mode of a mistyped env var has to be "the queue still
    // drains", never "background work silently stopped" — which is why the
    // check is for the one external value rather than against the one default.
    process.env.RESPARKABLE_WORKER_MODE = 'externl';
    registerResparkableJobs();

    await getAppJobs()
      .find((j) => j.name === RESPARKABLE_QUEUE_JOB_NAME)
      ?.run();
    expect(drainResparkableJobs).toHaveBeenCalledTimes(1);
  });
});

describe('resparkable_get_briefing', () => {
  it('serialises the stored row and generates nothing', async () => {
    vi.mocked(getStoredBriefing).mockResolvedValue({
      review: { id: 'b1', title: 'Tuesday', body: 'Prose.', generatedAt: ISO } as never,
      stale: false,
      ageHours: 6,
    });
    const capability = new ResparkableGetBriefingCapability();

    const result = await capability.execute(capability.validate({}), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      title: 'Tuesday',
      body: 'Prose.',
      generatedAt: ISO.toISOString(),
      stale: false,
      ageHours: 6,
    });
    // No generation path exists here at all — the workflow writes it.
    expect(buildBriefingInputs).not.toHaveBeenCalled();
  });

  it('reports an absent briefing as nulls plus stale, not as a failure', async () => {
    vi.mocked(getStoredBriefing).mockResolvedValue({ review: null, stale: true, ageHours: null });
    const capability = new ResparkableGetBriefingCapability();

    const result = await capability.execute(capability.validate({}), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ title: null, body: null, stale: true });
  });

  it('masks the prose in provenance — the body is the user’s week', async () => {
    const capability = new ResparkableGetBriefingCapability();

    const redaction = capability.redactProvenance({}, { success: true, data: undefined });

    expect(JSON.stringify(redaction)).not.toContain('Prose.');
    expect(redaction.resultPreview).toContain('redacted');
  });
});

describe('resparkable_get_briefing_inputs', () => {
  it('passes the validated override through to the selector', async () => {
    vi.mocked(buildBriefingInputs).mockResolvedValue({ workStyle: 'exploratory' } as never);
    const capability = new ResparkableGetBriefingInputsCapability();

    const args = capability.validate({ workStyleOverride: 'exploratory' });
    const result = await capability.execute(args, CONTEXT);

    expect(result.success).toBe(true);
    expect(vi.mocked(buildBriefingInputs).mock.calls[0]?.[1]).toEqual({
      workStyleOverride: 'exploratory',
    });
  });

  it('keeps the style in provenance and the selection out of it', () => {
    const capability = new ResparkableGetBriefingInputsCapability();

    const redaction = capability.redactProvenance(
      { workStyleOverride: 'exploratory' },
      { success: true, data: undefined }
    );

    // "Which style did that run use" is what an auditor comparing two briefings
    // asks; the selected rows are the user's own goals and notes.
    expect(redaction.args).toEqual({ workStyleOverride: 'exploratory' });
    expect(redaction.resultPreview).toContain('redacted');
  });

  it('rejects a style outside the enum rather than falling back silently', () => {
    const capability = new ResparkableGetBriefingInputsCapability();

    // The whole point of replacing the `route` step: the value is closed, so the
    // deterministic path cannot be steered somewhere unexpected.
    expect(() => capability.validate({ workStyleOverride: 'zen-mode' })).toThrow();
  });
});
