/**
 * The one place Resparkable writes into a **core-owned** table: queueing a
 * background workflow run.
 *
 * ## What used to be here
 *
 * Until phase 56 this file was `repo/schedules.ts` and it managed one
 * `AiWorkflowSchedule` row per user per workflow: creating four on signup,
 * rewriting their cron expressions after every DST change, stamping owners onto
 * rows written before resparkable#502, clearing stale `inputTemplate`s, deleting
 * them inside the erasure transaction, and sweeping up the ones whose
 * `createdBy` had been nulled behind an erasure hook that might not have fired.
 *
 * None of that exists any more. The queue (`framework_resparkable_job`) owns
 * *when* per-user work happens, and it stores an instant rather than an
 * expression — so there is no drift to correct, no row per user to create or
 * delete, and nothing outside the `ResparkableSpace` cascade for erasure to
 * chase. `phase-56-plan.md` §2 is the argument; the migration deleted the rows.
 *
 * What survives is the trigger itself, because that part was never the problem.
 *
 * ## Resparkable must only ever touch its own
 *
 * A host project has its own workflows in this table, so the `resparkable-`
 * slug prefix stays load-bearing rather than cosmetic — it is the only thing
 * distinguishing a workflow this tier owns from a host's, and the seeds, the
 * billing pass and the phase-56 migration all agree on it.
 */

import { prisma } from '@/lib/db/client';
import { WorkflowStatus } from '@/types/orchestration';
import type { Prisma } from '@prisma/client';

/**
 * The prefix every Resparkable workflow slug carries.
 *
 * Read by `jobs.ts`'s billing pass (which executions are ours to bill), by the
 * workflow-definition test (every seeded workflow must carry it), and by the
 * phase-56 migration's `DELETE` of the retired schedule rows. The seeds and
 * those three have to agree on it.
 */
export const RESPARKABLE_WORKFLOW_SLUG_PREFIX = 'resparkable-';

/**
 * Queue a run of one Resparkable workflow for a user, for the tick to pick up.
 *
 * ## Why a queued row rather than an inline engine call
 *
 * The alternative is to resolve the published version, build an execution
 * context and invoke `OrchestrationEngine` from the request — which is what the
 * scheduler does, in about eighty lines, with lease handling and budget
 * resolution around it. Re-implementing that in a route would give the briefing
 * its own private copy of the platform's execution semantics, and the copy would
 * drift.
 *
 * `processPendingExecutions` already runs `PENDING` rows off the maintenance
 * tick. So this writes the row the scheduler would have written and lets the
 * existing machinery run it. The cost is latency — the tick's stale threshold is
 * two minutes — which is exactly why the briefing is **pre-computed overnight**
 * and this path exists only for "the nightly run failed" and "surprise me
 * today". The button itself never comes here.
 *
 * Returns `null` when the workflow has no published version, which means the
 * seeds have not run. The caller reports that rather than queueing a row nothing
 * will ever execute.
 */
export async function queueResparkableWorkflowRun(
  slug: string,
  userId: string,
  inputData: Prisma.InputJsonValue
): Promise<string | null> {
  const workflow = await prisma.aiWorkflow.findUnique({
    where: { slug },
    select: {
      id: true,
      isActive: true,
      maxCostPerExecutionUsd: true,
      publishedVersionId: true,
    },
  });

  if (!workflow?.isActive || !workflow.publishedVersionId) return null;

  const execution = await prisma.aiWorkflowExecution.create({
    data: {
      workflowId: workflow.id,
      versionId: workflow.publishedVersionId,
      // `WorkflowStatus.PENDING`, never the literal. The column is a plain
      // `String`, and the value is lower-case `'pending'` — a hand-written
      // `'PENDING'` is accepted by the write and matched by nothing: not
      // `processPendingExecutions`, not the reaper, not the stuck-execution
      // dashboard. The row would sit there for ever while the route reported
      // `queued` and the card told the user to reload in a minute.
      status: WorkflowStatus.PENDING,
      inputData,
      executionTrace: [],
      // The same field the scheduler stamps from `createdBy` — this is how the
      // run knows whose brain it is, and it comes from the verified session.
      userId,
      ...(workflow.maxCostPerExecutionUsd !== null
        ? { budgetLimitUsd: workflow.maxCostPerExecutionUsd }
        : {}),
    },
    select: { id: true },
  });

  return execution.id;
}
