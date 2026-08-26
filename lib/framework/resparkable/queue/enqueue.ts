/**
 * Keeping the queue populated, and keeping it responsive.
 *
 * Three writes live here, and between them they are the whole lifecycle of a
 * job row outside the drain:
 *
 *   - **enqueue**, when a brain is created;
 *   - **wake**, when a dormant brain is written to;
 *   - **backfill**, the net under the first one.
 *
 * All three are best-effort by design. None of them may fail a user's request,
 * because all three sit behind writes a person is waiting on — creating their
 * space, capturing a thought, completing a task. A background job that arrives
 * late is a smaller problem than a capture that 500s.
 */

import {
  nextDueAt,
  RESPARKABLE_JOB_KINDS,
  isResparkableJobKind,
  type ResparkableJobKind,
} from '@/lib/framework/resparkable/queue/kinds';
import {
  clearResparkableJobDormancy,
  enqueueResparkableJobs,
  listSpacesWithoutJobs,
  pullResparkableJobsForward,
} from '@/lib/framework/resparkable/repo/jobs';
import { findSpaceByUserId } from '@/lib/framework/resparkable/repo/space';
import { logger } from '@/lib/logging';

/** Every kind's next occurrence for one owner, computed in one place. */
function dueAtByKind(timezone: string, now: Date): Record<ResparkableJobKind, Date> {
  return Object.fromEntries(
    RESPARKABLE_JOB_KINDS.map((kind) => [kind, nextDueAt(kind, timezone, now)])
  ) as Record<ResparkableJobKind, Date>;
}

/**
 * Give one owner their seven job rows. Idempotent, never throws.
 *
 * Called from `ensureResparkableSpace`'s create branch. Deliberately not called
 * on the existing-space branch, which is the hot read path under capture, chat
 * and every resource service: seven upserts there to catch a condition that
 * arises once per account would be the wrong trade, and
 * {@link backfillMissingResparkableJobs} covers it for free on the tick.
 */
export async function ensureResparkableJobs(
  userId: string,
  timezone: string,
  now: Date = new Date()
): Promise<number> {
  try {
    return await enqueueResparkableJobs(userId, dueAtByKind(timezone, now), now);
  } catch (error) {
    logger.warn('Resparkable jobs could not be enqueued for a new brain', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Wake a brain whose background work had gone dormant.
 *
 * Called behind every activity-log write, so its cost on an **active** brain has
 * to be one index probe and no more — which is what it is: a single
 * `UPDATE … WHERE "dormantSince" IS NOT NULL` that matches zero rows. Only a
 * genuine return-from-absence pays for the second statement.
 *
 * Due times are pulled forward with `LEAST`, never pushed out (see
 * `pullResparkableJobsForward`), so waking a brain can only ever make it more
 * responsive. Returning after three months therefore costs one cycle rather
 * than thirteen: the briefing that was parked a week out comes back to
 * tomorrow's 04:30.
 *
 * The timezone is looked up rather than passed, and **only on the branch that
 * actually woke something**. Callers of this are mutation paths that do not
 * hold the space row, and demanding one would push the lookup onto every write
 * instead of onto the rare one. `repo/space` is a leaf module — it imports
 * nothing but the Prisma client — so reading it from here adds no edge to the
 * import graph, which is the constraint `schedules/ensure.ts` had to be written
 * around before this phase deleted it.
 */
export async function wakeResparkableJobs(userId: string, now: Date = new Date()): Promise<number> {
  try {
    const woken = await clearResparkableJobDormancy(userId, now);
    if (woken.length === 0) return 0;

    // A brain with dormant jobs and no space row cannot happen — the FK is
    // `ON DELETE CASCADE` — but defaulting rather than asserting keeps a wake
    // from throwing on a path that must never fail a user's mutation.
    const timezone = (await findSpaceByUserId(userId))?.timezone ?? 'UTC';

    const revived = woken
      .filter((row) => isResparkableJobKind(row.kind))
      .map((row) => ({
        kind: row.kind,
        dueAt: nextDueAt(row.kind as ResparkableJobKind, timezone, now),
      }));

    await pullResparkableJobsForward(userId, revived, now);

    logger.info('Resparkable brain woken from dormancy', { userId, kinds: revived.length });
    return revived.length;
  } catch (error) {
    logger.warn('Resparkable dormancy wake failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * The net under {@link ensureResparkableJobs}: brains that ended up with no
 * job rows at all.
 *
 * The enqueue on signup is fire-and-forget and can miss — the seeds might not
 * have run, the database might have blinked. Before phase 56 the equivalent net
 * was the sweep rotation reaching every brain in turn; without a replacement, a
 * brain that missed its enqueue would have no background work for ever and
 * nothing anywhere would say so. That is precisely the class of silent hole the
 * tier already writes nets for (`deleteOrphanedResparkableSchedules` was the
 * last one, and it is deleted by this phase along with the rows it protected).
 *
 * Bounded, and cheap when there is nothing to do: an anti-join that stops at
 * the first job row per space and normally returns zero rows.
 */
export async function backfillMissingResparkableJobs(
  limit: number,
  now: Date = new Date()
): Promise<number> {
  const missing = await listSpacesWithoutJobs(limit);
  if (missing.length === 0) return 0;

  let enqueued = 0;
  for (const space of missing) {
    enqueued += await ensureResparkableJobs(space.userId, space.timezone, now);
  }

  logger.info('Resparkable backfilled job rows for brains that had none', {
    brains: missing.length,
    rows: enqueued,
  });
  return enqueued;
}
