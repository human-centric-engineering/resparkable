-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group collaboration and the activity feed (§23.13, §23.10,
-- phases 58 and 59). See phase-58-59-plan.md.
--
-- Purely additive. One new table and four nullable columns, no row rewritten.
--
--   framework_resparkable_task.assignedToUserId
--     Who in the group is doing this. Hand-written FK to "user" ON DELETE SET
--     NULL (losing a member must not delete the card), probe B15. Indexed with
--     spaceId for the "assigned to me" filter.
--
--   framework_resparkable_group.storageQuotaBytes
--     The most a group's retained document originals may total. NULL means the
--     default.
--
--   framework_resparkable_group_member.feedSeenAt
--     When this member last read the activity feed. Styling only, never a
--     filter. On the membership row, so it cascades with the user (probe B13).
--
--   framework_resparkable_group_audit_entry
--     Administrative actions in a group. Cascades from the group. actorUserId
--     and subjectUserId carry hand-written FKs to "user" ON DELETE SET NULL,
--     probe B13: erasing either person keeps the record and drops who.
--
-- Hand-written rather than taken from `prisma migrate diff`, for the reason
-- every group migration gives: the generated SQL also drops every hand-written
-- FK to "user" and the search-vector defaults Prisma cannot model.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_task" ADD COLUMN "assignedToUserId" TEXT;

-- AlterTable
ALTER TABLE "framework_resparkable_group" ADD COLUMN "storageQuotaBytes" BIGINT;

-- AlterTable
ALTER TABLE "framework_resparkable_group_member" ADD COLUMN "feedSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "framework_resparkable_group_audit_entry" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "subjectUserId" TEXT,
    "action" VARCHAR(32) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "framework_resparkable_group_audit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "framework_resparkable_task_spaceId_assignedToUserId_idx" ON "framework_resparkable_task"("spaceId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "framework_resparkable_group_audit_entry_groupId_createdAt_idx" ON "framework_resparkable_group_audit_entry"("groupId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "framework_resparkable_group_audit_entry_groupId_subjectUser_idx" ON "framework_resparkable_group_audit_entry"("groupId", "subjectUserId");

-- AddForeignKey
ALTER TABLE "framework_resparkable_group_audit_entry" ADD CONSTRAINT "framework_resparkable_group_audit_entry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "framework_resparkable_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: keys into Sunrise's "user" table, which this tier may not model
-- as relations (probes B13 and B15).
ALTER TABLE "framework_resparkable_task" ADD CONSTRAINT "framework_resparkable_task_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_audit_entry" ADD CONSTRAINT "framework_resparkable_group_audit_entry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "framework_resparkable_group_audit_entry" ADD CONSTRAINT "framework_resparkable_group_audit_entry_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
