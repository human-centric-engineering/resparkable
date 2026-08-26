-- Phase 56 follow-up: tell an event the person wrote from one the system wrote.
--
-- ## The defect this closes
--
-- The demand gate asks "has anything happened in this brain since the last
-- run?" and skips the run — no model call, no debit — when the answer is no.
-- It could never answer no. All four background workflows finish by calling
-- `resparkable_write_review`, which records a `ResparkableEvent`; nightly
-- triage additionally promotes thoughts and creates tasks, each of which
-- records one too. So every run wrote the evidence that authorised the next
-- run, for ever, on a brain nobody had touched. `wakeResparkableJobs` runs on
-- the same path, so those writes also cleared `dormantSince` for every OTHER
-- kind — the gate did not merely fail to fire, it re-armed the whole set.
--
-- Nothing about that is visible: the runs succeed, the log is green, and the
-- only symptom is a bill. It defeated the phase's own acceptance test ("an idle
-- brain consumes zero LLM calls across a simulated month") completely.
--
-- ## Why a column rather than a denylist
--
-- The obvious cheap fix is to exclude the event shapes background runs produce
-- — `entityType = 'review'` and so on. That is a denylist, and it drifts: it
-- silently stops working the day somebody adds a background writer that
-- produces a shape nobody thought to list, and the failure mode is the same
-- invisible over-billing. It also cannot separate "retention archived this" from
-- "the owner archived this", because those are the same row.
--
-- Authorship is a property of the write, so it belongs on the row. It is set
-- automatically at one chokepoint — `ResparkableCapability.execute` marks the
-- call when `CapabilityContext.workflowExecutionId` is present, which core
-- already sets for every capability dispatched from a workflow step — so a
-- background writer added later is marked without anyone remembering to.
--
-- ## Backfill
--
-- Existing rows default to 'user'. They predate the gate, so nothing has ever
-- read their authorship, and the only consequence is that the first gate check
-- after deploy sees a brain's last background review as user activity and
-- allows one extra run. That self-corrects on the following cycle and is much
-- the safer direction to be wrong in: the opposite default would suppress a
-- genuine capture made just before the migration.

ALTER TABLE "framework_resparkable_event"
    ADD COLUMN "source" VARCHAR(8) NOT NULL DEFAULT 'user';

-- The gate's index. `(userId, createdAt DESC)` already exists and stays — it
-- serves the weekly review and the briefing, which want the whole log — but it
-- cannot serve this query, because the gate's predicate sits BETWEEN the two
-- columns and a b-tree cannot skip a middle column.
--
-- The distinction matters most in exactly the case the gate exists for. On a
-- dormant brain every event since the last run is system-authored, so the
-- `EXISTS` has to walk all of them before it can answer "no" — the one answer
-- that saves money is the one that would otherwise cost the most to reach.
-- With `source` in the index it is a single index probe that touches no heap.
CREATE INDEX "framework_resparkable_event_userId_source_createdAt_idx"
    ON "framework_resparkable_event"("userId", "source", "createdAt" DESC);
