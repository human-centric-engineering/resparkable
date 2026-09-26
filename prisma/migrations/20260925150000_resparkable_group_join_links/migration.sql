-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group join links (§23.11, phase 57).
--
-- Purely additive. One new table and three nullable columns, no row rewritten.
-- One existing table does gain a constraint: the member table's new
-- `joinLinkId` gets a foreign key and an index. Every value is NULL when it is
-- added, so validating it reads the table without failing on any row.
--
--   framework_resparkable_group_join_link
--     A bearer credential to join one group. Cascades from the group. Holds no
--     reference to a person, so it needs no hand-written FK to "user" and no
--     drift probe (phase-57-plan.md decision 1).
--
--   framework_resparkable_group.joinRefusedFullAt
--     When a join link last turned somebody away because the group was full.
--
--   framework_resparkable_group_member.requestedAt
--     When a pending member asked to join. On the membership row, so it
--     cascades with the user (probe B13).
--
--   framework_resparkable_group_member.joinLinkId
--     The request link a pending member came through, SetNull to the link.
--
-- Hand-written rather than trimmed from `prisma migrate dev --create-only`, for
-- the reason every group migration gives: the generated SQL also drops every
-- hand-written FK to "user" and the search indexes Prisma cannot model.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group" ADD COLUMN "joinRefusedFullAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "framework_resparkable_group_member" ADD COLUMN "requestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "framework_resparkable_group_join_link" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(12) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'member',
    "approval" VARCHAR(16) NOT NULL DEFAULT 'request',
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_group_join_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "framework_resparkable_group_join_link_tokenHash_key" ON "framework_resparkable_group_join_link"("tokenHash");

-- CreateIndex
CREATE INDEX "framework_resparkable_group_join_link_groupId_createdAt_idx" ON "framework_resparkable_group_join_link"("groupId", "createdAt");

-- AddForeignKey
ALTER TABLE "framework_resparkable_group_join_link" ADD CONSTRAINT "framework_resparkable_group_join_link_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "framework_resparkable_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The request link a pending membership was filed through, so rejecting or
-- withdrawing the request gives the link its use back. SetNull: a link going
-- never takes a membership with it.
-- AlterTable
ALTER TABLE "framework_resparkable_group_member" ADD COLUMN "joinLinkId" TEXT;

-- AddForeignKey
ALTER TABLE "framework_resparkable_group_member" ADD CONSTRAINT "framework_resparkable_group_member_joinLinkId_fkey" FOREIGN KEY ("joinLinkId") REFERENCES "framework_resparkable_group_join_link"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "framework_resparkable_group_member_joinLinkId_idx" ON "framework_resparkable_group_member"("joinLinkId");
