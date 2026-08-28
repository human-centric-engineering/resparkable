-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable comments (Release 2, phase 13) — what makes `role: 'commenter'`
-- mean something.
--
-- The shape mirrors `framework_resparkable_grant`: `userId` is the OWNER of the
-- item, so the row cascades from `framework_resparkable_space` like everything
-- else in this tier, and the AUTHOR gets a second, hand-written foreign key
-- because they are somebody else.
--
-- ⚠️ Prisma will emit a DROP for that second FK on every future schema-diff run.
-- Probe B9 asserts it. Run `npm run db:drift-check` after every `migrate dev`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "framework_resparkable_comment" (
    "id" TEXT NOT NULL,
    -- The OWNER of the commented-on item, never the author.
    "userId" TEXT NOT NULL,
    "entityType" VARCHAR(16) NOT NULL,
    "entityId" TEXT NOT NULL,
    -- Never null. A comment with no author is a comment nobody can be
    -- accountable for; erasure deletes the row rather than orphaning it.
    "authorUserId" TEXT NOT NULL,
    -- Plain text, not markdown. A comment is a sentence, not a document, and
    -- rendering a grantee's markup on the owner's screen widens the surface for
    -- nothing the feature needs.
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_resparkable_comment_pkey" PRIMARY KEY ("id")
);

-- "what has been said on this item?", oldest first.
CREATE INDEX "framework_resparkable_comment_userId_entityType_entityId_createdAt_idx"
    ON "framework_resparkable_comment"("userId", "entityType", "entityId", "createdAt");

-- The erasure read, and the author's own "what have I written?" export.
CREATE INDEX "framework_resparkable_comment_authorUserId_idx"
    ON "framework_resparkable_comment"("authorUserId");

-- ── The owner cascade (D1) ──────────────────────────────────────────────────
ALTER TABLE "framework_resparkable_comment"
    ADD CONSTRAINT "framework_resparkable_comment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "framework_resparkable_space"("userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The author FK: Art. 17 for the person who wrote it ──────────────────────
--
-- Nothing cascades here when the AUTHOR is erased: `userId` is the owner of the
-- item, not the writer of the comment. `SET NULL` would keep free text an
-- erased person wrote — often about themselves — on a row they can no longer
-- reach, under an author nobody can name. §13 chose CASCADE deliberately.
--
-- Hand-written because `User` is Sunrise-owned; probe B9 asserts it.
ALTER TABLE "framework_resparkable_comment"
    ADD CONSTRAINT "framework_resparkable_comment_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
