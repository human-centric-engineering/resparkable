-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group budget (§23.12, phase 50): the per-member cap, the index its
-- pre-flight reads, and the job rows a group space was never owed.
--
--   framework_resparkable_group_member.dailyCreditCap
--     Credits a member may spend from the group's balance in any 24 hours.
--     Nullable, and null (uncapped) for every existing row.
--
--   framework_resparkable_credit_ledger_entry (spaceId, createdByUserId, createdAt)
--     What `sumMemberSpendSince` reads.
--
--   DELETE of the four personal job kinds on group spaces
--     The backfill net used to give every space all seven kinds. On a group
--     space the four workflow kinds (triage, briefing, weekly_review,
--     horizon_check) queue a run naming the group's space key as a user, which
--     it is not. `RESPARKABLE_JOB_KINDS_BY_SPACE_KIND` stops them coming back.
--     Job rows are scheduling state, not content: nothing is lost.
--
-- Hand-trimmed. `prisma migrate diff` also emitted a DROP for every
-- hand-written FK to "user", the tsvector/GIN and HNSW indexes, and the
-- searchVector defaults, because Prisma cannot model any of them. Every one of
-- those was removed; `npm run db:drift-check` fails if one ever comes back.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group_member" ADD COLUMN "dailyCreditCap" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "framework_resparkable_credit_ledger_entry_spaceId_createdBy_idx" ON "framework_resparkable_credit_ledger_entry"("spaceId", "createdByUserId", "createdAt");

-- Remove job rows a group space is not owed
DELETE FROM "framework_resparkable_job" j
USING "framework_resparkable_space" s
WHERE j."spaceId" = s."spaceId"
  AND s."kind" = 'group'
  AND j."kind" IN ('triage', 'briefing', 'weekly_review', 'horizon_check');
