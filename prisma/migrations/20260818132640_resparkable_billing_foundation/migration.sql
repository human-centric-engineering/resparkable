-- Phase 29: billing foundation.
--
-- The `DropForeignKey`/`DropIndex`/`AlterTable ... DROP DEFAULT` statements
-- Prisma generated ahead of the `CreateTable`s below were removed by hand.
-- They are the six raw-SQL-managed objects this schema's own drift warning
-- calls out (the hand-written `framework_resparkable_space` FK to `"user"`,
-- the HNSW index, and the GENERATED `tsvector` search-vector columns/indexes)
-- — Prisma can't model any of them, so every `migrate dev` diff proposes
-- dropping them. Per the schema header: always inspect and strip these
-- before applying; `npm run db:drift-check` verifies they're intact.

-- CreateTable
CREATE TABLE "framework_resparkable_credit_account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_credit_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_resparkable_credit_ledger_entry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "creditsDelta" DOUBLE PRECISION NOT NULL,
    "tokenCostUsd" DOUBLE PRECISION,
    "serviceChargeUsd" DOUBLE PRECISION,
    "totalUsd" DOUBLE PRECISION,
    "relatedConversationId" TEXT,
    "relatedWorkflowExecutionId" TEXT,
    "relatedCostLogId" TEXT,
    "note" VARCHAR(500),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "framework_resparkable_credit_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_resparkable_billing_settings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'global',
    "creditsPerUsd" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "serviceChargePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costVisibleToUsersDefault" BOOLEAN NOT NULL DEFAULT true,
    "currencyLabel" VARCHAR(32) NOT NULL DEFAULT 'credits',
    "newUserGrantCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "framework_resparkable_credit_account_userId_key" ON "framework_resparkable_credit_account"("userId");

-- CreateIndex
CREATE INDEX "framework_resparkable_credit_ledger_entry_userId_createdAt_idx" ON "framework_resparkable_credit_ledger_entry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "framework_resparkable_credit_ledger_entry_kind_relatedWorkf_key" ON "framework_resparkable_credit_ledger_entry"("kind", "relatedWorkflowExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_resparkable_billing_settings_slug_key" ON "framework_resparkable_billing_settings"("slug");

-- AddForeignKey
ALTER TABLE "framework_resparkable_credit_account" ADD CONSTRAINT "framework_resparkable_credit_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_resparkable_credit_ledger_entry" ADD CONSTRAINT "framework_resparkable_credit_ledger_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
