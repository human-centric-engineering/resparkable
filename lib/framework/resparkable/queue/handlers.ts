/**
 * What each job kind actually does when its turn comes.
 *
 * ## This phase replaces the trigger, not the executor
 *
 * The four workflow kinds do not run anything themselves — they write a
 * `PENDING` `AiWorkflowExecution` and stop, exactly as
 * `queueResparkableWorkflowRun` already did for the "regenerate my briefing"
 * button. `processPendingExecutions` picks it up on the maintenance tick and
 * the engine runs it unchanged. The workflows, their agents and their steps are
 * untouched by phase 56; only what pulls the trigger moved.
 *
 * That is also why the queued execution is **user-owned** (`userId` set) rather
 * than system-owned. resparkable#502 made *scheduler-fired* runs system-owned
 * for a good reason — `AiWorkflowExecution.userId` cascades, and naming an
 * operator on an org-level cron row meant erasing them destroyed the whole
 * organisation's run history. A Resparkable background run is the opposite
 * case: it belongs to one person, and erasing that person *should* take it with
 * them. So the owner rides in `userId` where it belongs, and the
 * `RESPARKABLE_SCHEDULE_OWNER_KEY` scope smuggling that ask #29 exists for is
 * no longer on this path at all.
 *
 * ## The three maintenance kinds
 *
 * `sweep`, `retention` and `reindex` call the tier's own services directly.
 * None of them is a moment, none calls a model, and all three are idempotent by
 * construction — which is what lets them be retried, run twice by two workers
 * racing a lease boundary, or abandoned halfway without leaving anything wrong.
 */

import { reindexPending } from '@/lib/framework/resparkable/embedding/indexer';
import type { ResparkableJobKind } from '@/lib/framework/resparkable/queue/kinds';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { sweepConnections } from '@/lib/framework/resparkable/search/connections';
import { enforceResparkableRetention } from '@/lib/framework/resparkable/services/retention';
import { RESPARKABLE_SCHEDULED_WORKFLOWS } from '@/lib/framework/resparkable/workflows/slugs';
import { logger } from '@/lib/logging';

/**
 * What a run produced, in terms the drain can log.
 *
 * Deliberately a flat bag of counts rather than a per-kind union: the drain
 * sums these across a batch of mixed kinds, and a union would make that sum a
 * switch statement in a second file.
 */
export interface JobRunOutcome {
  /** An `AiWorkflowExecution` was queued. */
  executionsQueued: number;
  /** Connection suggestions written by the sweep. */
  connectionsCreated: number;
  /** Rows archived and deleted by the retention pass. */
  retentionArchived: number;
  retentionPruned: number;
  /** Entities re-embedded by the reindex pass, and chunks written for them. */
  reindexEmbedded: number;
  reindexChunks: number;
  /**
   * The run completed but produced nothing it could have produced — a workflow
   * whose seeds are missing, a retention rule that hit its batch cap.
   *
   * Surfaced rather than swallowed because a capped or no-op run and a complete
   * one are otherwise the same green log line, which is the failure mode the
   * sweep's `cappedTypes` and retention's `capped` already exist to prevent.
   */
  incomplete: boolean;
}

const NOTHING: JobRunOutcome = {
  executionsQueued: 0,
  connectionsCreated: 0,
  retentionArchived: 0,
  retentionPruned: 0,
  reindexEmbedded: 0,
  reindexChunks: 0,
  incomplete: false,
};

/** The workflow slug each workflow-firing kind pulls the trigger on. */
type WorkflowJobKind = 'triage' | 'briefing' | 'weekly_review' | 'horizon_check';

const WORKFLOW_SLUG_BY_KIND: Record<WorkflowJobKind, string> = {
  triage: RESPARKABLE_SCHEDULED_WORKFLOWS.nightlyTriage,
  briefing: RESPARKABLE_SCHEDULED_WORKFLOWS.morningBriefing,
  weekly_review: RESPARKABLE_SCHEDULED_WORKFLOWS.weeklyReview,
  horizon_check: RESPARKABLE_SCHEDULED_WORKFLOWS.horizonCheck,
};

/**
 * Run one job.
 *
 * Throws on failure — the drain owns the backoff, the attempt count and the
 * error message, so a handler that swallowed its own exception would report
 * success for a run that did nothing and the row would be rescheduled at the
 * normal cadence as though it had worked.
 */
export async function runResparkableJob(
  kind: ResparkableJobKind,
  scope: SpaceScope,
  now: Date
): Promise<JobRunOutcome> {
  switch (kind) {
    // The four that pull a workflow trigger. Named individually rather than
    // handled by a lookup before the switch, so the `never` at the bottom is a
    // real exhaustiveness check: a kind added to `RESPARKABLE_JOB_KINDS`
    // without a handler fails type-check rather than at 03:15.
    case 'triage':
    case 'briefing':
    case 'weekly_review':
    case 'horizon_check':
      return queueWorkflow(WORKFLOW_SLUG_BY_KIND[kind], scope, kind);
    case 'sweep': {
      const result = await sweepConnections(scope, now);
      return {
        ...NOTHING,
        connectionsCreated: result.created,
        incomplete: result.cappedTypes.length > 0,
      };
    }
    case 'retention': {
      const result = await enforceResparkableRetention(scope, { now });
      return {
        ...NOTHING,
        retentionArchived: result.archived,
        retentionPruned: result.pruned,
        incomplete: result.capped,
      };
    }
    case 'reindex': {
      const result = await reindexPending(scope);
      return {
        ...NOTHING,
        reindexEmbedded: result.embedded,
        reindexChunks: result.chunks,
        // More rows are queued than one pass could take. Not a failure — the
        // next pass fifteen minutes from now continues — but worth saying, so a
        // brain that is permanently behind is visible rather than merely slow.
        incomplete: result.remaining > 0,
      };
    }
    default: {
      const unhandled: never = kind;
      throw new Error(`No handler for Resparkable job kind ${String(unhandled)}`);
    }
  }
}

/**
 * Queue one background workflow for one owner.
 *
 * A missing published version means the seeds have not run. That is reported as
 * an incomplete run rather than thrown: it is an install-state problem, not a
 * per-brain failure, and letting it burn through `attempts` would push a brain
 * into dormancy for something that will fix itself the moment somebody applies
 * the seeds.
 */
async function queueWorkflow(
  slug: string,
  scope: SpaceScope,
  kind: WorkflowJobKind
): Promise<JobRunOutcome> {
  const executionId = await queueResparkableWorkflowRun(slug, scope.spaceId, {});

  if (!executionId) {
    logger.warn('Resparkable job found no published workflow to queue', {
      kind,
      slug,
      userId: scope.spaceId,
    });
    return { ...NOTHING, incomplete: true };
  }

  return { ...NOTHING, executionsQueued: 1 };
}
