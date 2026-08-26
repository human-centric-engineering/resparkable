/**
 * Unit Tests: what each job kind actually does.
 *
 * The four workflow kinds do not run anything — they write a `PENDING`
 * `AiWorkflowExecution` and stop, and `processPendingExecutions` runs it on the
 * maintenance tick exactly as before. **Phase 56 replaced the trigger, not the
 * executor**, and the tests here are mostly about pinning that: the right slug
 * per kind, the owner stamped on the row, and a missing published version
 * reported rather than thrown.
 *
 * That last one matters more than it looks. A workflow with no published
 * version means the seeds have not run — an install-state problem, not a
 * per-brain failure — and throwing would burn `attempts` until the drain put
 * the brain to sleep for a week over something that fixes itself the moment
 * somebody applies the seeds.
 *
 * Test Coverage:
 * - Each workflow kind queues its own slug, owned by the job's owner
 * - A missing published version is `incomplete`, not a throw
 * - Each maintenance kind calls its service and reports its counts
 * - A capped sweep, a capped retention pass and a partial reindex all surface
 * - Handler failures propagate, because the drain owns the backoff
 *
 * @see lib/framework/resparkable/queue/handlers.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/workflow-runs', () => ({
  queueResparkableWorkflowRun: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/search/connections', () => ({
  sweepConnections: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/retention', () => ({
  enforceResparkableRetention: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/embedding/indexer', () => ({
  reindexPending: vi.fn(),
}));

import { runResparkableJob } from '@/lib/framework/resparkable/queue/handlers';
import { reindexPending } from '@/lib/framework/resparkable/embedding/indexer';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { sweepConnections } from '@/lib/framework/resparkable/search/connections';
import { enforceResparkableRetention } from '@/lib/framework/resparkable/services/retention';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-06-15T03:15:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queueResparkableWorkflowRun).mockResolvedValue('exec_1');
});

describe('the workflow kinds', () => {
  it.each([
    ['triage', 'resparkable-nightly-triage'],
    ['briefing', 'resparkable-morning-briefing'],
    ['weekly_review', 'resparkable-weekly-review'],
    ['horizon_check', 'resparkable-horizon-check'],
  ] as const)('%s queues %s for the job’s owner', async (kind, slug) => {
    const outcome = await runResparkableJob(kind, SCOPE, NOW);

    expect(queueResparkableWorkflowRun).toHaveBeenCalledWith(slug, 'user_a', {});
    expect(outcome.executionsQueued).toBe(1);
    expect(outcome.incomplete).toBe(false);
  });

  it('queues the run as USER-owned, not system-owned', async () => {
    // resparkable#502 made *scheduler*-fired runs system-owned because
    // `AiWorkflowExecution.userId` cascades and erasing an operator destroyed
    // an organisation's whole cron history. A Resparkable background run is the
    // opposite case: it belongs to one person and should be erased with them.
    // So the owner rides in `userId` where it belongs, and the scope-key
    // smuggling that ask #29 exists for is off this path entirely.
    await runResparkableJob('briefing', SCOPE, NOW);

    expect(vi.mocked(queueResparkableWorkflowRun).mock.calls[0]?.[1]).toBe('user_a');
  });

  it('reports a missing published version rather than throwing', async () => {
    // The seeds have not run. Throwing would burn `attempts` on an
    // install-state problem and put the brain to sleep for a week over
    // something that fixes itself the moment somebody applies the seeds.
    vi.mocked(queueResparkableWorkflowRun).mockResolvedValue(null);

    const outcome = await runResparkableJob('triage', SCOPE, NOW);

    expect(outcome.executionsQueued).toBe(0);
    expect(outcome.incomplete).toBe(true);
  });
});

describe('sweep', () => {
  it('reports what it created', async () => {
    vi.mocked(sweepConnections).mockResolvedValue({
      examined: 40,
      candidates: 6,
      created: 4,
      cappedTypes: [],
    });

    const outcome = await runResparkableJob('sweep', SCOPE, NOW);

    expect(sweepConnections).toHaveBeenCalledWith(SCOPE, NOW);
    expect(outcome.connectionsCreated).toBe(4);
    expect(outcome.incomplete).toBe(false);
  });

  it('surfaces a capped run, which otherwise looks identical to a complete one', async () => {
    vi.mocked(sweepConnections).mockResolvedValue({
      examined: 200,
      candidates: 12,
      created: 9,
      cappedTypes: ['thought'],
    });

    expect((await runResparkableJob('sweep', SCOPE, NOW)).incomplete).toBe(true);
  });
});

describe('retention', () => {
  it('reports what it archived and pruned', async () => {
    vi.mocked(enforceResparkableRetention).mockResolvedValue({
      rules: {} as never,
      archived: 12,
      pruned: 40,
      capped: false,
      dryRun: false,
    });

    const outcome = await runResparkableJob('retention', SCOPE, NOW);

    expect(enforceResparkableRetention).toHaveBeenCalledWith(SCOPE, { now: NOW });
    expect(outcome).toMatchObject({
      retentionArchived: 12,
      retentionPruned: 40,
      incomplete: false,
    });
  });

  it('surfaces a rule that hit its batch cap', async () => {
    vi.mocked(enforceResparkableRetention).mockResolvedValue({
      rules: {} as never,
      archived: 500,
      pruned: 0,
      capped: true,
      dryRun: false,
    });

    expect((await runResparkableJob('retention', SCOPE, NOW)).incomplete).toBe(true);
  });
});

describe('reindex', () => {
  it('reports embeddings written, and flags a queue that did not drain', async () => {
    // `remaining > 0` is not a failure — the next pass fifteen minutes later
    // continues — but a brain permanently behind should be visible rather than
    // merely slow.
    vi.mocked(reindexPending).mockResolvedValue({
      examined: 50,
      unchanged: 30,
      emptied: 0,
      embedded: 20,
      chunks: 44,
      remaining: 120,
    });

    const outcome = await runResparkableJob('reindex', SCOPE, NOW);

    expect(reindexPending).toHaveBeenCalledWith(SCOPE);
    expect(outcome).toMatchObject({ reindexEmbedded: 20, reindexChunks: 44, incomplete: true });
  });

  it('is complete when the queue drained', async () => {
    vi.mocked(reindexPending).mockResolvedValue({
      examined: 3,
      unchanged: 3,
      emptied: 0,
      embedded: 0,
      chunks: 0,
      remaining: 0,
    });

    expect((await runResparkableJob('reindex', SCOPE, NOW)).incomplete).toBe(false);
  });
});

describe('failure', () => {
  it('propagates, because the drain owns the backoff and the attempt count', async () => {
    // A handler that swallowed its own exception would report success for a run
    // that did nothing, and the row would be rescheduled at the normal cadence
    // as though it had worked.
    vi.mocked(sweepConnections).mockRejectedValue(new Error('dimension mismatch'));

    await expect(runResparkableJob('sweep', SCOPE, NOW)).rejects.toThrow('dimension mismatch');
  });
});
