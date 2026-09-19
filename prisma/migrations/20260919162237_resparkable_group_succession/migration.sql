-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group succession: the admin's say over who inherits the role,
-- and the record that the sole admin was told about it.
--
-- Purely additive. Two nullable-or-defaulted columns, no row rewritten, no
-- constraint touched.
--
--   framework_resparkable_group.viewersCanInheritAdmin
--     Defaults to true, which is the behaviour every existing group already
--     has: the longest-standing joined member inherits, whatever their role.
--
--   framework_resparkable_group_member.soleAdminNotifiedAt
--     Null until the member is emailed that they are the group's only admin.
--     On the membership row, so it cascades with the user (probe B13) and holds
--     no reference to a person that could outlive them.
--
-- Hand-trimmed. `prisma migrate dev --create-only` also emitted a DROP for every
-- hand-written FK to "user", the tsvector/GIN and HNSW indexes, and the
-- searchVector defaults, because Prisma cannot model any of them. Every one of
-- those was removed; `npm run db:drift-check` fails if one ever comes back.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_group" ADD COLUMN "viewersCanInheritAdmin" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "framework_resparkable_group_member" ADD COLUMN "soleAdminNotifiedAt" TIMESTAMP(3);
