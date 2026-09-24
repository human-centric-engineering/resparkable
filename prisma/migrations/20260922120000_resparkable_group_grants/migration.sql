-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable group-to-group sharing (§23.7, phase 49): a grant may name a
-- group workspace as its grantee instead of a person.
--
-- Additive. One nullable column, one relaxed NOT NULL, two indexes, one FK and
-- one CHECK. No row is rewritten: every existing grant names a person, has an
-- address and a null `granteeSpaceId`, and so already satisfies the CHECK.
--
--   framework_resparkable_grant.granteeSpaceId
--     The group space the grant was made to. Null for a grant to a person.
--     ON DELETE CASCADE into the space, because a grant to a group that no
--     longer exists is addressed to nobody.
--
--   framework_resparkable_grant.granteeEmail
--     Now nullable, and null exactly when `granteeSpaceId` is set.
--
-- Hand-trimmed. `prisma migrate diff` also emitted a DROP for every
-- hand-written FK to "user", the tsvector/GIN and HNSW indexes, and the
-- searchVector defaults, because Prisma cannot model any of them. Every one of
-- those was removed; `npm run db:drift-check` fails if one ever comes back.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "framework_resparkable_grant" ADD COLUMN "granteeSpaceId" TEXT,
ALTER COLUMN "granteeEmail" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "framework_resparkable_grant_granteeSpaceId_revokedAt_idx" ON "framework_resparkable_grant"("granteeSpaceId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "framework_resparkable_grant_entityType_entityId_granteeSpac_key" ON "framework_resparkable_grant"("entityType", "entityId", "granteeSpaceId");

-- AddForeignKey
ALTER TABLE "framework_resparkable_grant" ADD CONSTRAINT "framework_resparkable_grant_granteeSpaceId_fkey" FOREIGN KEY ("granteeSpaceId") REFERENCES "framework_resparkable_space"("spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- B14 — a grant names a person or a group, never both and never neither.
--
--   ⚠️ Not expressible in Prisma, so `migrate diff` will not recreate it and a
--   regenerated migration will not carry it. Probe B14 asserts it exists.
--
--   Both failure directions are access bugs. A grant with neither is live for
--   nobody and cannot be revoked by anything that lists grants by grantee. A
--   grant with both is read by two resolvers that each think it is theirs: the
--   person reads it in their personal workspace, which is exactly the implicit
--   crossing between spaces §23.7 forbids.
ALTER TABLE "framework_resparkable_grant"
  ADD CONSTRAINT "framework_resparkable_grant_one_grantee"
  CHECK (
    ("granteeEmail" IS NOT NULL AND "granteeSpaceId" IS NULL)
    OR ("granteeEmail" IS NULL AND "granteeSpaceId" IS NOT NULL AND "granteeUserId" IS NULL)
  );
