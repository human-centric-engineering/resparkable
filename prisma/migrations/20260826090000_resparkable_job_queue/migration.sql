-- Phase 56 — the job queue (scale.md S6).
-- See .context/framework/resparkable/phase-56-plan.md.
--
-- Three steps, in this order and for a reason:
--
--   1. Create "framework_resparkable_job".
--   2. Backfill one row per kind per existing brain, "dueAt" computed from that
--      brain's own timezone.
--   3. Delete every "AiWorkflowSchedule" row whose workflow slug is a
--      Resparkable slug.
--
-- Step 3 is the irreversible one and it happens AFTER step 2, so a brain is
-- never in a state where neither mechanism owns its background work. Running
-- them the other way round would leave a window — however short — in which the
-- nightly triage belongs to nobody.
--
-- "framework_resparkable_space"."lastSweptAt" and its index go last, for the
-- same ordering reason: the rotation cursor is only redundant once the queue
-- that replaces it holds every brain.

-- ── 1. The queue ────────────────────────────────────────────────────────────

CREATE TABLE "framework_resparkable_job" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "kind"           VARCHAR(24) NOT NULL,
    "dueAt"          TIMESTAMP(3) NOT NULL,
    "leasedBy"       VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "lastRunAt"      TIMESTAMP(3),
    "lastError"      TEXT,
    "dormantSince"   TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_job_pkey" PRIMARY KEY ("id")
);

-- Idempotent enqueue. `ensureResparkableSpace` and the drain's backfill net both
-- write "make sure this owner has a triage job" as ON CONFLICT DO NOTHING, and
-- this is what makes that a no-op rather than a duplicate.
CREATE UNIQUE INDEX "framework_resparkable_job_userId_kind_key"
    ON "framework_resparkable_job"("userId", "kind");

-- The claim query, and the only index it needs. Ordinary rather than partial:
-- the claim's predicate is now()-relative, so there is no time-independent
-- subset to index on.
CREATE INDEX "framework_resparkable_job_dueAt_leaseExpiresAt_idx"
    ON "framework_resparkable_job"("dueAt", "leaseExpiresAt");

-- D1: the cascade path. Erasing a user removes the space row, which removes
-- every job row with it — so erasure needs no code here, exactly like the other
-- twenty satellite tables.
ALTER TABLE "framework_resparkable_job"
    ADD CONSTRAINT "framework_resparkable_job_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
--
-- Every "dueAt" below is the next occurrence of that kind's cadence in the
-- BRAIN'S OWN timezone, which is the whole point of the column: the expressions
-- here and `queue/kinds.ts`'s `nextDueAt` compute the same thing, and after this
-- migration only the TypeScript one ever runs again.
--
-- An unrecognised timezone would make `AT TIME ZONE` throw and fail the whole
-- migration for every install, so the name is validated against
-- `pg_timezone_names` first and anything unknown falls back to UTC. Materialised
-- into a temp table rather than probed per row: `pg_timezone_names` is a
-- set-returning function of about 1,200 rows, and a correlated subquery over it
-- would re-expand it once per brain.
--
-- THE DOUBLE `AT TIME ZONE` IS NOT A TYPO, and getting it wrong is silent. The
-- first one reads the local wall clock as an instant (`timestamp` → `timestamptz`);
-- the second renders that instant back as UTC wall-clock (`timestamptz` →
-- `timestamp`), which is what a Prisma `DateTime` column holds. Without the
-- second, Postgres still casts to the column type — using the SESSION's zone —
-- so every row lands shifted by whatever offset the database server happens to
-- be running in. Nothing errors; the briefings just arrive at the wrong hour.

CREATE TEMP TABLE "_resparkable_tz_valid" AS
    SELECT name FROM pg_timezone_names;
CREATE INDEX ON "_resparkable_tz_valid"(name);

-- `triage` — daily at 03:15 local.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'triage',
       (CASE WHEN date_trunc('day', l.ln) + interval '3 hours 15 minutes' <= l.ln
             THEN date_trunc('day', l.ln) + interval '1 day 3 hours 15 minutes'
             ELSE date_trunc('day', l.ln) + interval '3 hours 15 minutes'
        END) AT TIME ZONE l.tz AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
LEFT JOIN "_resparkable_tz_valid" v ON v.name = s."timezone"
CROSS JOIN LATERAL (
    SELECT COALESCE(v.name, 'UTC') AS tz,
           now() AT TIME ZONE COALESCE(v.name, 'UTC') AS ln
) l
ON CONFLICT ("userId", "kind") DO NOTHING;

-- `briefing` — daily at 04:30 local. Fifteen minutes after triage rather than
-- chained off it: the briefing selects "the top five tasks", so triage has to
-- have finished reprioritising, and a gap is cheaper to reason about than a
-- cross-workflow dependency. If triage overruns, the briefing writes from
-- slightly staler ranking rather than from nothing.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'briefing',
       (CASE WHEN date_trunc('day', l.ln) + interval '4 hours 30 minutes' <= l.ln
             THEN date_trunc('day', l.ln) + interval '1 day 4 hours 30 minutes'
             ELSE date_trunc('day', l.ln) + interval '4 hours 30 minutes'
        END) AT TIME ZONE l.tz AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
LEFT JOIN "_resparkable_tz_valid" v ON v.name = s."timezone"
CROSS JOIN LATERAL (
    SELECT COALESCE(v.name, 'UTC') AS tz,
           now() AT TIME ZONE COALESCE(v.name, 'UTC') AS ln
) l
ON CONFLICT ("userId", "kind") DO NOTHING;

-- `retention` — daily at 02:00 local. Nothing about retention is a moment: no
-- user cares whether a 400-day-old event is deleted at 02:00 or at 14:00. It
-- gets a local hour anyway because a quiet one costs nothing and spreads the
-- load across the globe's clocks instead of piling it onto the server's.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'retention',
       (CASE WHEN date_trunc('day', l.ln) + interval '2 hours' <= l.ln
             THEN date_trunc('day', l.ln) + interval '1 day 2 hours'
             ELSE date_trunc('day', l.ln) + interval '2 hours'
        END) AT TIME ZONE l.tz AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
LEFT JOIN "_resparkable_tz_valid" v ON v.name = s."timezone"
CROSS JOIN LATERAL (
    SELECT COALESCE(v.name, 'UTC') AS tz,
           now() AT TIME ZONE COALESCE(v.name, 'UTC') AS ln
) l
ON CONFLICT ("userId", "kind") DO NOTHING;

-- `weekly_review` — Friday at 16:00 local. ISODOW is 1=Monday…7=Sunday, so
-- Friday is 5, and the modulo gives "days until the next Friday, or 0 if today
-- is one" — in which case the CASE below pushes it a week only if 16:00 has
-- already gone.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'weekly_review',
       (CASE WHEN c.candidate <= l.ln THEN c.candidate + interval '7 days' ELSE c.candidate END)
           AT TIME ZONE l.tz AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
LEFT JOIN "_resparkable_tz_valid" v ON v.name = s."timezone"
CROSS JOIN LATERAL (
    SELECT COALESCE(v.name, 'UTC') AS tz,
           now() AT TIME ZONE COALESCE(v.name, 'UTC') AS ln
) l
CROSS JOIN LATERAL (
    SELECT date_trunc('day', l.ln)
         + interval '16 hours'
         + (((5 - EXTRACT(ISODOW FROM l.ln)::int + 7) % 7) * interval '1 day') AS candidate
) c
ON CONFLICT ("userId", "kind") DO NOTHING;

-- `horizon_check` — 09:00 on the 2nd of the month, local.
--
-- The 2nd rather than the 1st is a fossil of the cron era and is kept anyway.
-- It was forced then, because `monthlyCron` had to shift the day when the local
-- hour rolled over and "the 0th" is not something a cron expression can say. It
-- is no longer forced — `dueAt` is an instant and has no such problem — but a
-- monthly goals review is indifferent to which of the first two days it lands
-- on, and moving everybody's by a day for tidiness would be a change users
-- would notice for no benefit they asked for.
--
-- `date_trunc('month', …) + interval '1 day'` IS the 2nd. Postgres clamps
-- `ln + interval '1 month'` on a 31st (Jan 31 → Feb 28), and truncating that to
-- the month start recovers the right February regardless.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'horizon_check',
       (CASE WHEN date_trunc('month', l.ln) + interval '1 day 9 hours' <= l.ln
             THEN date_trunc('month', l.ln + interval '1 month') + interval '1 day 9 hours'
             ELSE date_trunc('month', l.ln) + interval '1 day 9 hours'
        END) AT TIME ZONE l.tz AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
LEFT JOIN "_resparkable_tz_valid" v ON v.name = s."timezone"
CROSS JOIN LATERAL (
    SELECT COALESCE(v.name, 'UTC') AS tz,
           now() AT TIME ZONE COALESCE(v.name, 'UTC') AS ln
) l
ON CONFLICT ("userId", "kind") DO NOTHING;

-- The two interval kinds. Neither is a moment, so neither reads a timezone.
--
-- Both are JITTERED across their own period rather than set to now(). Without
-- it every brain in the install becomes due at the same instant the migration
-- commits, and the first drain after deploy faces the entire fleet at once.
-- That is survivable by design — a backlog makes rows late, not numerous — but
-- an even spread from the start is free and means the graph never has the spike
-- at all.
INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'sweep',
       (now() + (random() * interval '6 hours')) AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
ON CONFLICT ("userId", "kind") DO NOTHING;

INSERT INTO "framework_resparkable_job" ("id", "userId", "kind", "dueAt", "updatedAt")
SELECT gen_random_uuid()::text, s."userId", 'reindex',
       (now() + (random() * interval '15 minutes')) AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM "framework_resparkable_space" s
ON CONFLICT ("userId", "kind") DO NOTHING;

DROP TABLE "_resparkable_tz_valid";

-- ── 3. Retire the per-user cron rows ────────────────────────────────────────
--
-- Every brain now has its own queue rows, so the schedules are redundant — and
-- leaving them enabled would double-fire every background workflow, once from
-- the platform scheduler and once from the drain.
--
-- Filtered on the `resparkable-` slug prefix, which is the only thing
-- distinguishing "a schedule Resparkable created" from "a schedule the host
-- created" in a shared table. A host project's own schedules are untouched.
DELETE FROM "ai_workflow_schedule"
WHERE "workflowId" IN (SELECT "id" FROM "ai_workflow" WHERE "slug" LIKE 'resparkable-%');

-- ── 4. Drop the rotation cursor the queue replaces ──────────────────────────
--
-- `lastSweptAt` answered "who was worked on longest ago", which was the best
-- available question when one process-wide callback had to choose a brain. The
-- queue answers "what is owed, and when", per kind, which is strictly more
-- information. Keeping the column would leave two answers to "when was this
-- brain last worked on" and no rule about which one to believe.
DROP INDEX IF EXISTS "framework_resparkable_space_lastSweptAt_idx";
ALTER TABLE "framework_resparkable_space" DROP COLUMN IF EXISTS "lastSweptAt";
