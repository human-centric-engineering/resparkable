-- §110 t-788: index an org's month-to-date spend. `checkBudget()` sums
-- "totalCostUsd" WHERE "orgId" = ? AND "createdAt" >= <start of month> on
-- every chat turn once an org has a cap, and the per-org metering rollup reads
-- the same range. The existing single-column "orgId" index would scan every
-- row the org has ever written.
--
-- Not CONCURRENTLY (Prisma migrations run in a transaction), so the build
-- holds a lock that scales with the table.

-- CreateIndex
CREATE INDEX "ai_cost_log_orgId_createdAt_idx" ON "ai_cost_log"("orgId", "createdAt");
