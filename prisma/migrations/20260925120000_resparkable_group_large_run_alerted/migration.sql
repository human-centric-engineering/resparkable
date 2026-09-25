-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group large-run alert throttle (§23.12, phase 50 review).
--
--   framework_resparkable_group.largeRunAlertedAt
--     When the admin-only large-run alert last went out. The alert is sent at
--     most once in any 24 hours per group. Nullable, null for every row.
--
-- Hand-written. Nothing Prisma cannot model is touched here.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group" ADD COLUMN "largeRunAlertedAt" TIMESTAMP(3);
