-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group billing: who pays, and the group's books (§23.12's second
-- amendment, phase 62). See phase-62-plan.md.
--
-- Purely additive. Every default is what phase 50 does today, so no group
-- changes behaviour until an admin changes a setting.
--
--   framework_resparkable_group
--     Seat prices per role, who pays operational and activity costs, the
--     allowance source, the shortfall policy, settings pending until the next
--     month, and how far the monthly cycle has been settled.
--     operationalPayerUserId carries a hand-written FK to "user" ON DELETE SET
--     NULL, probe B16.
--
--   framework_resparkable_group_member
--     A member's own group balance (may go below zero: a debt), their
--     allowance and how much of it is left, and the automatic top-up they set.
--     On the membership row, so it cascades with the user (probe B13).
--
--   framework_resparkable_credit_ledger_entry.memberUserId
--     Whose group balance a row moves. Hand-written FK to "user" ON DELETE SET
--     NULL, probe B16. Indexed with spaceId and createdAt for the books.
--
-- The new `group_cycle` job kind needs no rows here: the queue's backfill net
-- (`listSpacesWithoutJobs`) counts each space's rows against the kinds it is
-- owed and writes what is missing.
--
-- Hand-written rather than taken from `prisma migrate diff`, for the reason
-- every group migration gives: the generated SQL also drops every hand-written
-- FK to "user" and the search-vector defaults Prisma cannot model.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group"
  ADD COLUMN "seatPriceAdminCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "seatPriceMemberCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "seatPriceViewerCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "operationalCostsPaidBy" VARCHAR(16) NOT NULL DEFAULT 'pool',
  ADD COLUMN "operationalPayerUserId" TEXT,
  ADD COLUMN "activityCostsPaidBy" VARCHAR(16) NOT NULL DEFAULT 'pool',
  ADD COLUMN "allowanceSource" VARCHAR(16) NOT NULL DEFAULT 'carved',
  ADD COLUMN "shortfallPolicy" VARCHAR(16) NOT NULL DEFAULT 'debt',
  ADD COLUMN "pendingBilling" JSONB,
  ADD COLUMN "pendingBillingFrom" TIMESTAMP(3),
  ADD COLUMN "cycleSettledThrough" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "framework_resparkable_group_member"
  ADD COLUMN "balanceCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "allowanceCredits" DOUBLE PRECISION,
  ADD COLUMN "allowanceRemainingCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "autoTopUpMonthlyCredits" DOUBLE PRECISION,
  ADD COLUMN "autoTopUpUsedCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "autoTopUpMonth" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "framework_resparkable_credit_ledger_entry" ADD COLUMN "memberUserId" TEXT;

-- CreateIndex
CREATE INDEX "framework_resparkable_credit_ledger_entry_spaceId_memberUse_idx" ON "framework_resparkable_credit_ledger_entry"("spaceId", "memberUserId", "createdAt");

-- Hand-written: keys into Sunrise's "user" table, which this tier may not model
-- as relations (probe B16).
ALTER TABLE "framework_resparkable_group" ADD CONSTRAINT "framework_resparkable_group_operationalPayerUserId_fkey" FOREIGN KEY ("operationalPayerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_credit_ledger_entry" ADD CONSTRAINT "framework_resparkable_credit_ledger_entry_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
