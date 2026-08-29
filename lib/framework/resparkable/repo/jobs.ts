/**
 * Job-queue repo — the claim, the settle, and the two writes that keep the
 * queue populated.
 *
 * ## Why this file is raw SQL
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` is the entire reason this design scales
 * where the platform scheduler does not, and Prisma cannot express it.
 *
 * `processDueSchedules` uses an **optimistic lock** on `nextRunAt`: every
 * worker reads the same `take: 50` rows and all but one loses the update race,
 * so the losers did their read for nothing. That is fine at one instance and
 * wasteful at ten — throughput stops climbing exactly when you add capacity to
 * make it climb. `SKIP LOCKED` hands each worker a *disjoint* batch in one
 * statement: a row another transaction already holds is stepped over rather
 * than contended for, so N workers do N times the work instead of N times the
 * reading.
 *
 * This is the second file in the tier to need raw SQL (the first is
 * `repo/embeddings.ts`) and it obeys the same two rules: raw SQL lives only
 * inside `repo/**`, and `userId` is never string-interpolated — every value
 * below is a `$queryRaw` parameter.
 *
 * ## Why the claim is unscoped
 *
 * `claimResparkableJobs` takes no `SpaceScope`, because its whole job is to
 * *choose* one. It is the same deliberate exception `listSpacesDueSweep` used
 * to be, and it is safe for the same reason: it returns an owner id, a kind and
 * a timezone, and no brain content whatsoever. Each id is minted into its own
 * scope by the caller and every subsequent read goes back through the normal
 * owner-scoped path. D5 is untouched — this picks a scope, it does not bypass
 * one.
 */

import { prisma } from '@/lib/db/client';
import {
  RESPARKABLE_JOB_KINDS,
  type ResparkableJobKind,
} from '@/lib/framework/resparkable/queue/kinds';
import { Prisma } from '@prisma/client';

/** One claimed job, with the owner's zone so the caller needs no second read. */
export interface ClaimedResparkableJob {
  id: string;
  userId: string;
  kind: string;
  dueAt: Date;
  attempts: number;
  lastRunAt: Date | null;
  dormantSince: Date | null;
  /** From the joined `ResparkableSpace`. Wall-clock kinds resolve against it. */
  timezone: string;
}

/**
 * Lease a batch of due jobs to one worker, atomically.
 *
 * The `FROM "framework_resparkable_space"` join is not decoration: it makes the
 * owner's timezone part of the claim's `RETURNING`, so a worker draining fifty
 * jobs issues one statement rather than fifty-one. The FK guarantees the join
 * matches, so it cannot narrow what is claimed.
 *
 * `leasedBy` is a worker identity rather than a boolean, and that is what makes
 * {@link completeResparkableJob} safe: a worker whose lease expired mid-run
 * cannot settle a row that has since been re-claimed by somebody else.
 */
export async function claimResparkableJobs(
  workerId: string,
  batchSize: number,
  leaseMs: number,
  now: Date
): Promise<ClaimedResparkableJob[]> {
  if (batchSize <= 0) return [];

  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return prisma.$queryRaw<ClaimedResparkableJob[]>`
    UPDATE "framework_resparkable_job" j
    SET "leasedBy" = ${workerId},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "updatedAt" = ${now}
    FROM "framework_resparkable_space" s
    WHERE j."spaceId" = s."spaceId"
      AND j."id" IN (
        SELECT "id" FROM "framework_resparkable_job"
        WHERE "dueAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
        ORDER BY "dueAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
    RETURNING j."id", j."spaceId", j."kind", j."dueAt", j."attempts",
              j."lastRunAt", j."dormantSince", s."timezone"
  `;
}

export interface SettleResparkableJobInput {
  /** When this kind is next owed. Always recomputed, never carried forward. */
  dueAt: Date;
  /** The instant the run finished, or `null` for a run that was skipped. */
  lastRunAt: Date | null;
  /** Set to stamp dormancy, `null` to clear it, `undefined` to leave it alone. */
  dormantSince?: Date | null;
}

/**
 * Release a job that succeeded (or was deliberately skipped).
 *
 * Resets `attempts` and clears `lastError`, because both describe a run of
 * failures that has now ended. Leaving them would make the next failure's
 * backoff start from wherever the last streak got to, which is a job that gets
 * progressively harder to recover the longer it has been running.
 *
 * **`leasedBy` is in the WHERE clause and that is load-bearing.** A worker that
 * stalled past its lease has already had its row handed to someone else; a
 * settle from the stalled worker would clear the new holder's lease and let a
 * third worker claim the same job while the second is still running it. Nothing
 * about that is visible in a log line. Matching on the lease makes the stale
 * settle a zero-row update instead, which is exactly right — it no longer owns
 * the row.
 */
export async function completeResparkableJob(
  id: string,
  workerId: string,
  input: SettleResparkableJobInput,
  now: Date
): Promise<boolean> {
  const dormancy =
    input.dormantSince === undefined
      ? Prisma.empty
      : Prisma.sql`, "dormantSince" = ${input.dormantSince}`;

  const affected = await prisma.$executeRaw`
    UPDATE "framework_resparkable_job"
    SET "dueAt" = ${input.dueAt},
        "lastRunAt" = COALESCE(${input.lastRunAt}::timestamp, "lastRunAt"),
        "attempts" = 0,
        "lastError" = NULL,
        "leasedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = ${now}
        ${dormancy}
    WHERE "id" = ${id} AND "leasedBy" = ${workerId}
  `;

  return affected > 0;
}

export interface FailResparkableJobInput {
  dueAt: Date;
  attempts: number;
  lastError: string;
  /** Set when the failure cap is reached — see `drain.ts`'s `MAX_ATTEMPTS`. */
  dormantSince?: Date | null;
}

/**
 * Release a job that threw, with its backoff already applied to `dueAt`.
 *
 * Same lease guard as {@link completeResparkableJob}, for the same reason.
 * `lastRunAt` IS stamped on a failure: it means "when was this attempted", and
 * a demand gate that treated failed attempts as never having happened would
 * re-run a permanently broken job against every event written since the last
 * *success*, for ever.
 */
export async function failResparkableJob(
  id: string,
  workerId: string,
  input: FailResparkableJobInput,
  now: Date
): Promise<boolean> {
  const dormancy =
    input.dormantSince === undefined
      ? Prisma.empty
      : Prisma.sql`, "dormantSince" = ${input.dormantSince}`;

  const affected = await prisma.$executeRaw`
    UPDATE "framework_resparkable_job"
    SET "dueAt" = ${input.dueAt},
        "lastRunAt" = ${now},
        "attempts" = ${input.attempts},
        "lastError" = ${input.lastError},
        "leasedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = ${now}
        ${dormancy}
    WHERE "id" = ${id} AND "leasedBy" = ${workerId}
  `;

  return affected > 0;
}

/**
 * Give one owner a full set of job rows. Idempotent.
 *
 * Called from `ensureResparkableSpace`'s create branch, and again from the
 * drain's backfill net for any brain that slipped through. `ON CONFLICT DO
 * NOTHING` is what makes the second call free rather than a duplicate — and
 * what makes "the enqueue failed on signup" a recoverable condition rather than
 * a brain that never gets a briefing.
 *
 * **Ids come from `gen_random_uuid()::text`, not from `@default(cuid())`.**
 * Prisma generates a cuid client-side, and this insert never goes through the
 * client's data mapper — so the column needs a database-side default of its
 * own or the `INSERT` has nothing to put there. The result is that job ids are
 * uuid-shaped while the rest of the tier is cuid-shaped. Nothing reads a job id
 * for meaning and nothing parses its format, so the mix is cosmetic; it is
 * called out because a reader comparing the schema to this file would otherwise
 * be right to wonder which one wins.
 *
 * Deliberately does NOT update `dueAt` on an existing row. A repeat call is
 * asking "does this owner have these jobs", not "reschedule them" — and pulling
 * a due time forward from a hot read path is how you build a nightly workflow
 * that runs at lunchtime.
 */
export async function enqueueResparkableJobs(
  userId: string,
  dueAtByKind: Record<ResparkableJobKind, Date>,
  now: Date
): Promise<number> {
  const values = RESPARKABLE_JOB_KINDS.map(
    (kind) =>
      Prisma.sql`(gen_random_uuid()::text, ${userId}, ${kind}, ${dueAtByKind[kind]}, ${now})`
  );

  return prisma.$executeRaw`
    INSERT INTO "framework_resparkable_job" ("id", "spaceId", "kind", "dueAt", "updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("spaceId", "kind") DO NOTHING
  `;
}

/**
 * Wake a dormant brain: clear the flag and report which kinds were asleep.
 *
 * Two statements rather than one, and the split is the point. The first is a
 * single indexed update that matches **nothing** for an active brain, which is
 * the overwhelmingly common case — this runs behind every event write, so its
 * cost on the hot path has to be one index probe and no more. Only when
 * somebody genuinely is returning after an absence does the caller pay for
 * recomputing due times.
 *
 * The caller pulls `dueAt` back in from those kinds' natural cadences (see
 * {@link pullResparkableJobsForward}), rather than this doing it in SQL: "the
 * next 04:30 in Auckland" is wall-clock arithmetic, and there is exactly one
 * implementation of it in the tier.
 */
export async function clearResparkableJobDormancy(
  userId: string,
  now: Date
): Promise<Array<{ kind: string; dueAt: Date }>> {
  return prisma.$queryRaw<Array<{ kind: string; dueAt: Date }>>`
    UPDATE "framework_resparkable_job"
    SET "dormantSince" = NULL, "updatedAt" = ${now}
    WHERE "spaceId" = ${userId} AND "dormantSince" IS NOT NULL
    RETURNING "kind", "dueAt"
  `;
}

/**
 * Bring a woken job's due time back in, but never push it out.
 *
 * `LEAST` rather than an assignment: a dormant `briefing` is parked a week out
 * and should come back to tomorrow's 04:30, while a `reindex` that happens to
 * be due in thirty seconds must not be pushed to fifteen minutes because
 * somebody wrote a note. The one-way rule means waking a brain can only ever
 * make it more responsive.
 */
export async function pullResparkableJobsForward(
  userId: string,
  dueAtByKind: Array<{ kind: string; dueAt: Date }>,
  now: Date
): Promise<number> {
  if (dueAtByKind.length === 0) return 0;

  const cases = dueAtByKind.map(
    (entry) => Prisma.sql`WHEN ${entry.kind} THEN ${entry.dueAt}::timestamp`
  );
  const kinds = dueAtByKind.map((entry) => entry.kind);

  return prisma.$executeRaw`
    UPDATE "framework_resparkable_job"
    SET "dueAt" = LEAST("dueAt", CASE "kind" ${Prisma.join(cases, ' ')} END),
        "updatedAt" = ${now}
    WHERE "spaceId" = ${userId} AND "kind" IN (${Prisma.join(kinds)})
  `;
}

/**
 * Brains missing any of their job rows — the safety net under the enqueue on
 * signup, and the only thing that carries a NEW KIND to existing brains.
 *
 * The enqueue in `ensureResparkableSpace` is fire-and-forget and never allowed
 * to fail a new user's first page load, so it can miss. Before this phase the
 * equivalent net was the sweep rotation reaching every brain in turn; without a
 * replacement, a brain that missed its enqueue would have no background work
 * for ever and nothing anywhere would say so.
 *
 * **Counted, not merely probed for existence**, and that is the difference
 * between a net and a formality. `kind` is a plain string precisely so the
 * vocabulary can grow by code change plus a backfill — but a brain that already
 * has seven of eight rows satisfies a `NOT EXISTS (… j."spaceId" = s."spaceId")`
 * and is invisible to it, so every existing user would silently never get the
 * new kind. Comparing the count against what this build expects catches both
 * the brand-new brain and the one a deploy left a kind short.
 *
 * `ensureResparkableJobs` is `ON CONFLICT DO NOTHING`, so re-running it against
 * a partial set writes only what is missing and leaves existing due times
 * alone. Bounded by `limit` because this runs on a tick.
 */
export async function listSpacesWithoutJobs(
  limit: number,
  expectedKinds: number = RESPARKABLE_JOB_KINDS.length
): Promise<Array<{ userId: string; timezone: string }>> {
  return prisma.$queryRaw<Array<{ userId: string; timezone: string }>>`
    SELECT s."spaceId", s."timezone"
    FROM "framework_resparkable_space" s
    LEFT JOIN "framework_resparkable_job" j ON j."spaceId" = s."spaceId"
    GROUP BY s."spaceId", s."timezone", s."createdAt"
    HAVING count(j."id") < ${expectedKinds}
    ORDER BY s."createdAt" ASC
    LIMIT ${limit}
  `;
}

/**
 * Has **the person** done anything in this brain since `since`? The demand
 * gate's one question.
 *
 * ## `source = 'user'` is the whole question, not a refinement of it
 *
 * The obvious version of this query — any event since `since` — can never
 * answer "no", because the background runs write events too. All four workflows
 * finish by recording a `review`, nightly triage records every thought it
 * promotes and every task it creates, and retention records what it archived.
 * Each run therefore produces the evidence that authorises the next one, on a
 * brain nobody has touched, and the gate becomes decorative: an idle brain is
 * billed nightly, silently, for ever. `services/authorship.ts` has the full
 * account and how the marking is applied.
 *
 * ## Why `EXISTS` over a count, and why the dedicated index
 *
 * The answer is a boolean, so `EXISTS` stops at the first matching row and a
 * brain with fifty thousand events does not pay to learn it.
 *
 * It reads `@@index([userId, source, createdAt(sort: Desc)])` rather than the
 * older `(userId, createdAt DESC)`, which cannot serve this: `source` sits
 * between the two columns and a b-tree cannot skip a middle one. That matters
 * most in exactly the case worth optimising — on a dormant brain every event
 * since the last run is system-authored, so the wrong index would walk all of
 * them to reach "no", making the one answer that saves money the most expensive
 * to compute.
 */
export async function hasResparkableActivitySince(userId: string, since: Date): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "framework_resparkable_event"
      WHERE "spaceId" = ${userId}
        AND "source" = 'user'
        AND "createdAt" > ${since}
    ) AS present
  `;
  return rows[0]?.present === true;
}

/** Queue depth by kind, for the drain's log line and the smoke script. */
export async function countDueResparkableJobs(now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ due: bigint }>>`
    SELECT count(*)::bigint AS due
    FROM "framework_resparkable_job"
    WHERE "dueAt" <= ${now}
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
  `;
  return Number(rows[0]?.due ?? 0n);
}
