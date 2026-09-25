-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group funding (§23.12, phase 50 second half): how a group's
-- balance is filled, and the two thresholds only its admins hear about.
--
--   framework_resparkable_group.fundingMode
--     'self_funded' (admins top up) or 'member_contributions' (any member may).
--     Every existing group starts self-funded, which is what §23.12 said before
--     the amendment.
--
--   framework_resparkable_group.lowBalanceAlertCredits / largeRunAlertPercent
--     Nullable, and null (off) for every existing row.
--
-- The ledger gains two `kind` values (transfer_out, transfer_in). The column is
-- an unconstrained VarChar(16), so no DDL is needed for them.
--
-- Hand-written. Nothing Prisma cannot model is touched here.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group" ADD COLUMN "fundingMode" VARCHAR(24) NOT NULL DEFAULT 'self_funded',
ADD COLUMN "largeRunAlertPercent" INTEGER,
ADD COLUMN "lowBalanceAlertCredits" DOUBLE PRECISION;
