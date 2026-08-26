-- Resparkable Release 1.5, phase 9e: sensitivity reaches the vector layer.
-- See .context/framework/resparkable/plan.md §15 (Release 1.5) and §16.
--
-- ⚠️ THE STANDING PRISMA-DIFF WARNING APPLIES HERE TOO. `prisma migrate dev`
-- cannot model this table's pgvector column, its generated tsvector, or the
-- hand-written FK into "user", so a regenerated diff will try to "fix" all
-- three. This migration is hand-written for that reason; the drift probes fail
-- the build if a regenerated one ever lands.

-- ── The column ──────────────────────────────────────────────────────────────
--
-- Denormalised from the source row. Every read path except this one goes
-- through a repo function that can filter the source table; the vector pass
-- ranks chunks, so before this column a `sensitive` thought was a candidate for
-- every unattended agent's search — including `resparkable-strategist`, which
-- writes `ResparkableReview` bodies, and reviews are shareable (§13).
--
-- NOT NULL with a default, so every existing row is `'private'` immediately and
-- the backfill below only has to move the rows that are anything else. VarChar(16)
-- matches `ResparkableThought.sensitivity`, which is where the values come from.
ALTER TABLE "framework_resparkable_embedding"
  ADD COLUMN "sensitivity" VARCHAR(16) NOT NULL DEFAULT 'private';

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Only `thought` rows can be anything but the default: no other embedded type
-- carries the column. Joined on (userId, id) rather than id alone — the join is
-- inside one user's rows by construction, and it keeps the shape of every other
-- statement in this tier.
--
-- Rows classified `'public'` are left as the thought says: 'public' is an
-- explicit opt-in a person makes by hand, and the filter added in this phase
-- tests for `<> 'sensitive'`, so 'public' and 'private' behave identically to it.
UPDATE "framework_resparkable_embedding" e
SET "sensitivity" = t."sensitivity"
FROM "framework_resparkable_thought" t
WHERE e."entityType" = 'thought'
  AND e."entityId" = t."id"
  AND e."userId" = t."userId"
  AND t."sensitivity" <> 'private';

-- No index. The filter is `AND e."sensitivity" <> 'sensitive'` applied to a
-- candidate set already narrowed by `("userId", "entityType")`, which for one
-- person's brain is thousands of rows, not millions. An index here would be the
-- same mistake S3 just undid: a real write cost for a read nothing can use.
