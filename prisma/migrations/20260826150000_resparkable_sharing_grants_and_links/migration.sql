-- Resparkable Release 2, phase 10: the two tables access resolution reads.
-- See .context/framework/resparkable/plan.md §13.
--
-- ⚠️ THE STANDING PRISMA-DIFF WARNING APPLIES. The `granteeUserId` FK below is
-- hand-written for the same reason `framework_resparkable_space_userId_fkey`
-- is: `User` lives in a Sunrise-owned schema file and this tier must not add a
-- relation field there. A regenerated migration will not emit it, and losing it
-- is an Art. 17 violation rather than a broken query — see probe B8.

-- ── Named grants ────────────────────────────────────────────────────────────
CREATE TABLE "framework_resparkable_grant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" VARCHAR(16) NOT NULL,
    "entityId" TEXT NOT NULL,
    "granteeUserId" TEXT,
    "granteeEmail" TEXT NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'viewer',
    "includeTaskDetail" BOOLEAN NOT NULL DEFAULT false,
    "inviteTokenHash" TEXT,
    "inviteSentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "framework_resparkable_grant_inviteTokenHash_key"
    ON "framework_resparkable_grant"("inviteTokenHash");

-- One grant per address per item: re-granting is an update, not a second row.
CREATE UNIQUE INDEX "framework_resparkable_grant_entityType_entityId_granteeEmail_key"
    ON "framework_resparkable_grant"("entityType", "entityId", "granteeEmail");

-- The access layer's two reads, by whichever half of the grantee identity the
-- viewer presents: an accepted grant is found by id, an unaccepted one by email.
CREATE INDEX "framework_resparkable_grant_granteeUserId_revokedAt_idx"
    ON "framework_resparkable_grant"("granteeUserId", "revokedAt");
CREATE INDEX "framework_resparkable_grant_granteeEmail_revokedAt_idx"
    ON "framework_resparkable_grant"("granteeEmail", "revokedAt");

-- The owner's read: "who can see this item?"
CREATE INDEX "framework_resparkable_grant_userId_entityType_entityId_idx"
    ON "framework_resparkable_grant"("userId", "entityType", "entityId");

-- D1: the owner cascade, which Prisma models.
ALTER TABLE "framework_resparkable_grant"
    ADD CONSTRAINT "framework_resparkable_grant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The grantee FK: Art. 17 for the person on the receiving end ─────────────
--
-- Nothing cascades to this row when the GRANTEE is erased: `userId` is the
-- owner, so the owner cascade does not reach it. `SET NULL` would be worse than
-- nothing — it leaves a live grant addressed by `granteeEmail`, which is
-- retained personal data belonging to an erased person on a row they cannot
-- reach. Hand-written because `User` is Sunrise-owned; probe B8 asserts it.
ALTER TABLE "framework_resparkable_grant"
    ADD CONSTRAINT "framework_resparkable_grant_granteeUserId_fkey"
    FOREIGN KEY ("granteeUserId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Public share links ──────────────────────────────────────────────────────
CREATE TABLE "framework_resparkable_share_link" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" VARCHAR(16) NOT NULL,
    "entityId" TEXT NOT NULL,
    -- sha256 hex of a 192-bit random token. The only copy that survives minting.
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(12) NOT NULL,
    "includeChildren" BOOLEAN NOT NULL DEFAULT false,
    "includeTaskDetail" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_share_link_pkey" PRIMARY KEY ("id")
);

-- The public reader's only lookup, and the reason the token is hashed: this
-- index is over digests, so a database dump hands over no working links.
CREATE UNIQUE INDEX "framework_resparkable_share_link_tokenHash_key"
    ON "framework_resparkable_share_link"("tokenHash");

CREATE INDEX "framework_resparkable_share_link_userId_entityType_entityId_idx"
    ON "framework_resparkable_share_link"("userId", "entityType", "entityId");

ALTER TABLE "framework_resparkable_share_link"
    ADD CONSTRAINT "framework_resparkable_share_link_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId")
    ON DELETE CASCADE ON UPDATE CASCADE;
