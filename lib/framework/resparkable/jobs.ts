/**
 * What Resparkable puts on the maintenance tick, now that it owns a queue.
 *
 * ## What this file used to be, and why it is smaller
 *
 * Until phase 56 this was the per-brain rotation: one `registerAppJob` callback
 * paging through spaces oldest-swept-first, doing a connection sweep, a
 * schedule-correction pass and a retention pass for four brains every six
 * hours, plus an unconditional billing poll. Every one of those had a ceiling
 * in it — `SWEEP_BATCH = 4` per six hours is a full rotation per day for about
 * twelve users, and `BILLING_BATCH = 100` newest-first silently stopped billing
 * anything past the hundredth completion in a window.
 *
 * All of that work still happens. It is just no longer *scheduled* here: it is
 * seven rows per brain in `framework_resparkable_job`, claimed with
 * `SELECT … FOR UPDATE SKIP LOCKED`, and the rotation cursor
 * (`ResparkableSpace.lastSweptAt`) is gone with the code that needed it. What
 * is left in this file is the two things that are genuinely tick-shaped:
 * calling the drain with a small budget, and the billing pass.
 *
 * ## Why the tick still drains at all
 *
 * Because a fork installing Resparkable for a team of thirty should not have to
 * run a second process to get a briefing. `drainResparkableJobs` is a bounded
 * call, so the tick can take a few jobs and twenty seconds of it and stop;
 * `npm run framework:resparkable:worker` calls the identical function with a large budget
 * in a loop. Nothing about the queue's correctness depends on which one is
 * running, because the lease lives in the database rather than in
 * `registerAppJob`'s process memory.
 *
 * A scaled install sets `RESPARKABLE_WORKER_MODE=external` so the tick stops
 * draining and the worker containers have the queue to themselves. That is a
 * throughput choice, not a correctness one — leaving it unset on a
 * six-container deployment costs contention, not double runs.
 */

import { RESPARKABLE_JOB_KINDS } from '@/lib/framework/resparkable/queue/kinds';
import { backfillMissingResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';
import { drainResparkableJobs, type DrainResult } from '@/lib/framework/resparkable/queue/drain';
import {
  findUnbilledTerminalResparkableExecutions,
  type BillableWorkflowExecution,
} from '@/lib/framework/resparkable/repo/billing';
import {
  spaceScope,
  readResparkableScheduleSpaceId,
} from '@/lib/framework/resparkable/repo/space-scope';
import { isUniqueConstraintViolation } from '@/lib/framework/resparkable/repo/shared';
import { recordAgentSpend } from '@/lib/framework/resparkable/services/billing';
import { RESPARKABLE_CONTEXT_DIGEST_WORKFLOW_SLUG } from '@/lib/framework/resparkable/workflows/definitions';
import { RESPARKABLE_SCHEDULED_WORKFLOWS } from '@/lib/framework/resparkable/workflows/slugs';
import { logger } from '@/lib/logging';
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';
import { WorkflowStatus } from '@/types/orchestration';

export const RESPARKABLE_QUEUE_JOB_NAME = 'resparkable:job-queue';

/**
 * The tick's budget: a handful of jobs, well inside the 60-second tick it
 * shares with everything else on it.
 *
 * These numbers are what a single-container install lives on, and they are
 * deliberately modest rather than tuned: at this budget the tick drains 240
 * jobs an hour, which covers a few hundred brains comfortably and degrades into
 * *latency* rather than into a growing queue above that — one row per kind per
 * brain, however far behind the workers fall. An operator who wants more runs
 * the worker.
 */
const TICK_MAX_JOBS = 4;
const TICK_MAX_WALL_CLOCK_MS = 20_000;
const TICK_CONCURRENCY = 2;

/** Brains repaired per tick by the enqueue net. Rarely more than zero. */
const BACKFILL_BATCH = 5;

/**
 * Every workflow slug that can produce a billable `AiWorkflowExecution`: the
 * four the queue fires, plus the context-digest workflow `/summarize` queues on
 * demand (`api/handlers.ts`). `queueResparkableWorkflowRun` is the only way a
 * resparkable-slug execution is created, so this list has to track every slug
 * ever passed to it — one added there without a matching entry here bills
 * nothing for that workflow, silently.
 *
 * The three maintenance kinds create no execution and have nothing to bill.
 */
const RESPARKABLE_BILLABLE_WORKFLOW_SLUGS: string[] = [
  ...Object.values(RESPARKABLE_SCHEDULED_WORKFLOWS),
  RESPARKABLE_CONTEXT_DIGEST_WORKFLOW_SLUG,
];

const TERMINAL_WORKFLOW_STATUSES: string[] = [
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
];

/**
 * Executions billed per pass.
 *
 * A **bound**, not a window — which is the whole difference from the
 * `BILLING_BATCH = 100` this replaces. Rows this pass does not reach are still
 * candidates on the next one, because the candidate set is an anti-join against
 * the ledger rather than the newest N rows (see
 * `findUnbilledTerminalResparkableExecutions`). So a spike of completions makes
 * billing take a few more passes; it can no longer make billing lose rows.
 */
const BILLING_BATCH = 100;

export interface ResparkableTickResult extends DrainResult {
  /** Ledger rows written for newly terminal executions. */
  executionsBilled: number;
  /** Terminal executions that could not be attributed to a user, so not billed. */
  executionsSkipped: number;
  /** Job rows created for brains that somehow had none. */
  jobsBackfilled: number;
}

/**
 * Resolve a workflow execution's owner.
 *
 * `userId` for everything the queue and the routes create — phase 56 queues
 * background runs as user-owned, which is correct for a run that belongs to one
 * person and should be erased with them.
 *
 * `scope[RESPARKABLE_SCHEDULE_OWNER_KEY]` is the legacy branch: executions
 * fired by the platform scheduler before the cutover are system-owned
 * (`userId: null`) and carry the owner in `scope` instead (resparkable#502; ask
 * #29). Nothing creates those any more, but the ones already in the table still
 * have to be billed, and they age out on their own.
 *
 * `null` for anything else — an org-level or non-Resparkable run — which the
 * caller must skip rather than bill to somebody.
 */
function resolveExecutionOwner(execution: BillableWorkflowExecution): string | null {
  if (execution.userId) return execution.userId;

  // Untrusted JSON from a platform-owned column, so every non-object shape is
  // rejected before anything is read out of it — an array is an object to
  // `typeof` and a bare string indexes to `undefined` rather than throwing, so
  // neither would error, they would just quietly resolve to "no owner". The
  // strict version of this check used to live in `repo/schedules.ts`'s
  // `carriesOwnerScope`, which phase 56 deleted along with the rows it read;
  // this is that check, kept.
  const scope: unknown = execution.scope;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null;

  // Either key: phase 45 writes `resparkableSpaceId` alongside the old
  // `resparkableUserId` rather than replacing it, so a schedule row created
  // before the migration still resolves here.
  return readResparkableScheduleSpaceId(scope as Record<string, unknown>) ?? null;
}

/**
 * Write the ledger entry for every terminal execution that has not got one.
 *
 * Independent of the queue and of any per-user cursor: a completed workflow's
 * bill should not wait for that user's turn at anything. Idempotent via the
 * ledger's own `@@unique([kind, relatedWorkflowExecutionId])` — a repeat over an
 * already-billed execution throws `P2002`, which is caught and skipped here
 * rather than logged as an error, and is the backstop for two workers racing
 * the same row.
 */
async function billResparkableWorkflowExecutions(): Promise<{ billed: number; skipped: number }> {
  const executions = await findUnbilledTerminalResparkableExecutions(
    RESPARKABLE_BILLABLE_WORKFLOW_SLUGS,
    TERMINAL_WORKFLOW_STATUSES,
    BILLING_BATCH
  );

  let billed = 0;
  let skipped = 0;

  for (const execution of executions) {
    const ownerUserId = resolveExecutionOwner(execution);
    if (!ownerUserId) {
      skipped++;
      continue;
    }

    try {
      const entry = await recordAgentSpend(spaceScope(ownerUserId), {
        tokenCostUsd: execution.totalCostUsd,
        relatedWorkflowExecutionId: execution.id,
      });
      if (entry) billed++;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) continue;
      logger.error('Resparkable workflow-execution billing failed for one run', {
        executionId: execution.id,
        userId: ownerUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { billed, skipped };
}

/**
 * One tick's worth of work: bill, repair, drain.
 *
 * Exported for the tests and the smoke script — a job body reachable only
 * through the maintenance tick is a job body nobody exercises.
 *
 * The billing pass runs **first and unconditionally**, before the drain and
 * regardless of `RESPARKABLE_WORKER_MODE`. It is not per-user work and has no
 * business being in the queue: putting it there would mean a person's bill
 * waited on their own brain's turn, and would give the largest table in the
 * system an eighth kind that does nothing for the owner it is keyed on.
 */
export async function runResparkableTick(
  options: { drain?: boolean } = {}
): Promise<ResparkableTickResult> {
  const { billed: executionsBilled, skipped: executionsSkipped } =
    await billResparkableWorkflowExecutions();

  const jobsBackfilled = await backfillMissingResparkableJobs(BACKFILL_BATCH).catch(
    (error: unknown) => {
      // Its own catch: the net under the enqueue must not cost the drain its
      // turn. A brain missing its rows stays missing for one more tick, which
      // is the same order of delay the net already tolerates.
      logger.warn('Resparkable job backfill failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  );

  const drained =
    options.drain === false
      ? emptyDrain()
      : await drainResparkableJobs({
          maxJobs: TICK_MAX_JOBS,
          maxWallClockMs: TICK_MAX_WALL_CLOCK_MS,
          concurrency: TICK_CONCURRENCY,
        });

  return { ...drained, executionsBilled, executionsSkipped, jobsBackfilled };
}

/**
 * What a tick that did not drain reports.
 *
 * A function rather than a shared constant: `applyOutcome` in `drain.ts`
 * accumulates into `result.outcome` with `+=`, so handing every caller the same
 * object identity is one refactor away from a tick silently summing into a
 * module-level singleton and reporting the whole process's history as this
 * minute's work.
 */
function emptyDrain(): DrainResult {
  return {
    settled: 0,
    skippedDormant: 0,
    skippedNoCredit: 0,
    skippedUnknown: 0,
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
}

/**
 * Register the tick job. Called from `lib/app/jobs.ts`.
 *
 * Every 60 seconds rather than every six hours, because the unit of work is now
 * one job rather than a whole rotation: a short interval and a small budget
 * gives low latency on a quiet install and bounded cost on a busy one, where
 * the old six-hour rotation gave neither.
 *
 * `intervalMs` is a **minimum gap** kept in process memory, so N instances run
 * this about N times per interval and a restart re-arms it. That is fine here
 * and it is fine for a reason worth stating precisely, because it is the bar
 * anything else registered on this seam has to clear: the drain does not rely
 * on `registerAppJob` for correctness at all. Two ticks racing claim disjoint
 * batches from the database, and the billing pass is idempotent through a
 * unique constraint.
 */
export function registerResparkableJobs(): void {
  const drain = resolveWorkerMode() !== 'external';

  registerAppJob({
    name: RESPARKABLE_QUEUE_JOB_NAME,
    intervalMs: 60_000,
    run: async () => runResparkableTick({ drain }),
  });
}

/**
 * Whether this process should drain the queue from its tick.
 *
 * Read from the environment directly rather than through `lib/env.ts`, because
 * `registerResparkableJobs` is called lazily from core's `app-jobs.ts` in
 * whichever realm the tick runs in, and this is a single optional string with a
 * safe default. Anything unrecognised means `tick`: the failure mode of a typo
 * should be "the queue still drains", never "background work silently stopped".
 */
function resolveWorkerMode(): 'tick' | 'external' {
  return process.env.RESPARKABLE_WORKER_MODE === 'external' ? 'external' : 'tick';
}

/** Re-exported so the worker entrypoint and the smoke script agree on the set. */
export { RESPARKABLE_JOB_KINDS };
