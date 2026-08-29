-- Phase 45 (Release 9, `plan.md` §23.2 + §24.1 + §24.2): the tier's owner key
-- becomes `spaceId`, and the GDPR cascade moves to a new nullable `ownerUserId`.
--
-- ⚠️ HAND-WRITTEN. DO NOT REGENERATE. ⚠️
-- `prisma migrate dev --create-only` renders this as 24 × `DROP COLUMN "userId"`
-- followed by `ADD COLUMN "spaceId"`, which would silently empty every table in
-- the brain. Verified, not assumed: the generated file for this exact schema
-- carried 24 DROP COLUMN statements. Every one was replaced by the RENAME below.
--
-- Also scrubbed from the generated file, being the raw-SQL objects Prisma cannot
-- model and re-drops on every diff (see the schema header and `db-drift.ts`):
--   DROP INDEX "idx_ai_knowledge_chunk_search_vector"          (probe A2)
--   DROP INDEX "idx_knowledge_embedding"                       (probe A3)
--   DROP INDEX "idx_message_embedding"                         (probe A4)
--   DROP INDEX "idx_framework_resparkable_task_search_vector"  (probe B5)
--   ALTER TABLE ... ALTER COLUMN "searchVector" DROP DEFAULT   (× 3, probes A1/B4/B6)
--   ALTER TABLE ... DROP CONSTRAINT "framework_resparkable_comment_authorUserId_fkey"  (probe B9)
--   ALTER TABLE ... DROP CONSTRAINT "framework_resparkable_grant_granteeUserId_fkey"   (probe B8)
--
-- Nothing here rewrites a satellite row. RENAME COLUMN updates
-- `pg_attribute.attname` and leaves `attnum` alone, so every index and
-- constraint keeps working and no heap page is touched; `ADD COLUMN` with a
-- constant default is metadata-only on PG 11+. The only writes are the single
-- backfill UPDATE on the parent and the three `scope` key additions at the end.
-- Proven either side by `npm run framework:resparkable:key-checksum`.
--
-- Full reasoning: .context/framework/resparkable/phase-45-plan.md

-- The `ADD COLUMN ... NOT NULL DEFAULT <constant>` statements below are only
-- metadata-only from PG 11. On PG 10 they rewrite every table in the brain,
-- which is the one thing this migration exists to avoid, so refuse rather than
-- do it slowly and silently.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 110000 THEN
    RAISE EXCEPTION 'phase 45 requires PostgreSQL 11 or later (found %)',
      current_setting('server_version');
  END IF;
END $$;

-- ── 1. Release the cascade FK. It is being MOVED to another column, and a
--       constraint cannot be moved by rename. Re-added at step 7, on
--       "ownerUserId", after the backfill that gives it values to validate.
ALTER TABLE "framework_resparkable_space"
  DROP CONSTRAINT "framework_resparkable_space_userId_fkey";

-- ── 2. The parent's key. Every satellite FK follows it automatically: a foreign
--       key references its target by attnum, which a rename does not change.
ALTER TABLE "framework_resparkable_space" RENAME COLUMN "userId" TO "spaceId";

-- ── 3. The same on all 23 satellites, generated from the schema's relation
--       declarations rather than transcribed from §23.2 (which says 21: comments,
--       share links and the job queue arrived after that count was written).
ALTER TABLE "framework_resparkable_area" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_board" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_board_card" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_checklist_item" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_comment" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_credit_account" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_credit_ledger_entry" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_document" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_embedding" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_entity" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_event" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_goal" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_grant" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_job" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_link" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_project" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_review" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_share_link" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_tag" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_task" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_task_tag" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_thought" RENAME COLUMN "userId" TO "spaceId";
ALTER TABLE "framework_resparkable_time_block" RENAME COLUMN "userId" TO "spaceId";

-- ── 4. Rename the objects named after the column.
--
--       Not cosmetic. Leave them and Prisma decides they are misnamed and injects
--       a phantom `ALTER INDEX ... RENAME TO` into EVERY future migration,
--       including ones touching unrelated tables, which the next person scrubs
--       incorrectly (the `ai_conversation_inbound_key` case in
--       `.context/database/prisma-7-baseline-bugs.md`).
--
--       These names were harvested from Prisma's own `--from-empty` render of the
--       renamed schema and paired structurally by (kind, table, column list), not
--       derived by substituting on the string. Four of them are already at
--       Postgres's 63-character limit, so adding a character to `userId` moves the
--       truncation point somewhere no hand-derivation would put it.
ALTER INDEX "framework_resparkable_area_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_area_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_area_userId_slug_key"
  RENAME TO "framework_resparkable_area_spaceId_slug_key";
ALTER INDEX "framework_resparkable_area_userId_visibility_idx"
  RENAME TO "framework_resparkable_area_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_board_card_userId_idx"
  RENAME TO "framework_resparkable_board_card_spaceId_idx";
ALTER INDEX "framework_resparkable_board_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_board_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_board_userId_slug_key"
  RENAME TO "framework_resparkable_board_spaceId_slug_key";
ALTER INDEX "framework_resparkable_board_userId_visibility_idx"
  RENAME TO "framework_resparkable_board_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_checklist_item_userId_idx"
  RENAME TO "framework_resparkable_checklist_item_spaceId_idx";
ALTER INDEX "framework_resparkable_comment_userId_entityType_entityId_create"
  RENAME TO "framework_resparkable_comment_spaceId_entityType_entityId_c_idx";
ALTER INDEX "framework_resparkable_credit_account_userId_key"
  RENAME TO "framework_resparkable_credit_account_spaceId_key";
ALTER INDEX "framework_resparkable_credit_ledger_entry_userId_createdAt_idx"
  RENAME TO "framework_resparkable_credit_ledger_entry_spaceId_createdAt_idx";
ALTER INDEX "framework_resparkable_document_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_document_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_document_userId_fileHash_key"
  RENAME TO "framework_resparkable_document_spaceId_fileHash_key";
ALTER INDEX "framework_resparkable_document_userId_status_idx"
  RENAME TO "framework_resparkable_document_spaceId_status_idx";
ALTER INDEX "framework_resparkable_embedding_userId_contentHash_idx"
  RENAME TO "framework_resparkable_embedding_spaceId_contentHash_idx";
ALTER INDEX "framework_resparkable_embedding_userId_entityType_entityId__key"
  RENAME TO "framework_resparkable_embedding_spaceId_entityType_entityId_key";
ALTER INDEX "framework_resparkable_embedding_userId_entityType_idx"
  RENAME TO "framework_resparkable_embedding_spaceId_entityType_idx";
ALTER INDEX "framework_resparkable_entity_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_entity_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_entity_userId_kind_status_idx"
  RENAME TO "framework_resparkable_entity_spaceId_kind_status_idx";
ALTER INDEX "framework_resparkable_entity_userId_slug_key"
  RENAME TO "framework_resparkable_entity_spaceId_slug_key";
ALTER INDEX "framework_resparkable_event_userId_createdAt_idx"
  RENAME TO "framework_resparkable_event_spaceId_createdAt_idx";
ALTER INDEX "framework_resparkable_event_userId_entityType_entityId_idx"
  RENAME TO "framework_resparkable_event_spaceId_entityType_entityId_idx";
ALTER INDEX "framework_resparkable_event_userId_kind_createdAt_idx"
  RENAME TO "framework_resparkable_event_spaceId_kind_createdAt_idx";
ALTER INDEX "framework_resparkable_event_userId_source_createdAt_idx"
  RENAME TO "framework_resparkable_event_spaceId_source_createdAt_idx";
ALTER INDEX "framework_resparkable_goal_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_goal_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_goal_userId_horizon_status_idx"
  RENAME TO "framework_resparkable_goal_spaceId_horizon_status_idx";
ALTER INDEX "framework_resparkable_goal_userId_slug_key"
  RENAME TO "framework_resparkable_goal_spaceId_slug_key";
ALTER INDEX "framework_resparkable_goal_userId_visibility_idx"
  RENAME TO "framework_resparkable_goal_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_grant_userId_entityType_entityId_idx"
  RENAME TO "framework_resparkable_grant_spaceId_entityType_entityId_idx";
ALTER INDEX "framework_resparkable_job_userId_kind_key"
  RENAME TO "framework_resparkable_job_spaceId_kind_key";
ALTER INDEX "framework_resparkable_link_userId_sourceType_sourceId_idx"
  RENAME TO "framework_resparkable_link_spaceId_sourceType_sourceId_idx";
ALTER INDEX "framework_resparkable_link_userId_sourceType_sourceId_targe_key"
  RENAME TO "framework_resparkable_link_spaceId_sourceType_sourceId_targ_key";
ALTER INDEX "framework_resparkable_link_userId_status_idx"
  RENAME TO "framework_resparkable_link_spaceId_status_idx";
ALTER INDEX "framework_resparkable_link_userId_targetType_targetId_idx"
  RENAME TO "framework_resparkable_link_spaceId_targetType_targetId_idx";
ALTER INDEX "framework_resparkable_project_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_project_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_project_userId_priorityScore_idx"
  RENAME TO "framework_resparkable_project_spaceId_priorityScore_idx";
ALTER INDEX "framework_resparkable_project_userId_slug_key"
  RENAME TO "framework_resparkable_project_spaceId_slug_key";
ALTER INDEX "framework_resparkable_project_userId_status_idx"
  RENAME TO "framework_resparkable_project_spaceId_status_idx";
ALTER INDEX "framework_resparkable_project_userId_visibility_idx"
  RENAME TO "framework_resparkable_project_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_review_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_review_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_review_userId_horizon_generatedAt_idx"
  RENAME TO "framework_resparkable_review_spaceId_horizon_generatedAt_idx";
ALTER INDEX "framework_resparkable_review_userId_visibility_idx"
  RENAME TO "framework_resparkable_review_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_share_link_userId_entityType_entityId_idx"
  RENAME TO "framework_resparkable_share_link_spaceId_entityType_entityI_idx";
ALTER INDEX "framework_resparkable_space_userId_key"
  RENAME TO "framework_resparkable_space_spaceId_key";
ALTER INDEX "framework_resparkable_tag_userId_slug_key"
  RENAME TO "framework_resparkable_tag_spaceId_slug_key";
ALTER INDEX "framework_resparkable_task_tag_userId_idx"
  RENAME TO "framework_resparkable_task_tag_spaceId_idx";
ALTER INDEX "framework_resparkable_task_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_task_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_task_userId_dueAt_idx"
  RENAME TO "framework_resparkable_task_spaceId_dueAt_idx";
ALTER INDEX "framework_resparkable_task_userId_priorityScore_idx"
  RENAME TO "framework_resparkable_task_spaceId_priorityScore_idx";
ALTER INDEX "framework_resparkable_task_userId_status_idx"
  RENAME TO "framework_resparkable_task_spaceId_status_idx";
ALTER INDEX "framework_resparkable_task_userId_visibility_idx"
  RENAME TO "framework_resparkable_task_spaceId_visibility_idx";
ALTER INDEX "framework_resparkable_thought_userId_archivedAt_idx"
  RENAME TO "framework_resparkable_thought_spaceId_archivedAt_idx";
ALTER INDEX "framework_resparkable_thought_userId_externalId_key"
  RENAME TO "framework_resparkable_thought_spaceId_externalId_key";
ALTER INDEX "framework_resparkable_thought_userId_status_createdAt_idx"
  RENAME TO "framework_resparkable_thought_spaceId_status_createdAt_idx";
ALTER INDEX "framework_resparkable_time_block_userId_startAt_idx"
  RENAME TO "framework_resparkable_time_block_spaceId_startAt_idx";

-- The pre-existing mismatch on the grant's unique index. It carries no `userId`
-- and is nothing to do with this phase, but while it stands `prisma migrate diff`
-- is never empty, and real drift hides inside known noise.
ALTER INDEX "framework_resparkable_grant_entityType_entityId_granteeEmail_ke"
  RENAME TO "framework_resparkable_grant_entityType_entityId_granteeEmai_key";

ALTER TABLE "framework_resparkable_area"
  RENAME CONSTRAINT "framework_resparkable_area_userId_fkey"
  TO "framework_resparkable_area_spaceId_fkey";
ALTER TABLE "framework_resparkable_board_card"
  RENAME CONSTRAINT "framework_resparkable_board_card_userId_fkey"
  TO "framework_resparkable_board_card_spaceId_fkey";
ALTER TABLE "framework_resparkable_board"
  RENAME CONSTRAINT "framework_resparkable_board_userId_fkey"
  TO "framework_resparkable_board_spaceId_fkey";
ALTER TABLE "framework_resparkable_checklist_item"
  RENAME CONSTRAINT "framework_resparkable_checklist_item_userId_fkey"
  TO "framework_resparkable_checklist_item_spaceId_fkey";
ALTER TABLE "framework_resparkable_comment"
  RENAME CONSTRAINT "framework_resparkable_comment_userId_fkey"
  TO "framework_resparkable_comment_spaceId_fkey";
ALTER TABLE "framework_resparkable_credit_account"
  RENAME CONSTRAINT "framework_resparkable_credit_account_userId_fkey"
  TO "framework_resparkable_credit_account_spaceId_fkey";
ALTER TABLE "framework_resparkable_credit_ledger_entry"
  RENAME CONSTRAINT "framework_resparkable_credit_ledger_entry_userId_fkey"
  TO "framework_resparkable_credit_ledger_entry_spaceId_fkey";
ALTER TABLE "framework_resparkable_document"
  RENAME CONSTRAINT "framework_resparkable_document_userId_fkey"
  TO "framework_resparkable_document_spaceId_fkey";
ALTER TABLE "framework_resparkable_embedding"
  RENAME CONSTRAINT "framework_resparkable_embedding_userId_fkey"
  TO "framework_resparkable_embedding_spaceId_fkey";
ALTER TABLE "framework_resparkable_entity"
  RENAME CONSTRAINT "framework_resparkable_entity_userId_fkey"
  TO "framework_resparkable_entity_spaceId_fkey";
ALTER TABLE "framework_resparkable_event"
  RENAME CONSTRAINT "framework_resparkable_event_userId_fkey"
  TO "framework_resparkable_event_spaceId_fkey";
ALTER TABLE "framework_resparkable_goal"
  RENAME CONSTRAINT "framework_resparkable_goal_userId_fkey"
  TO "framework_resparkable_goal_spaceId_fkey";
ALTER TABLE "framework_resparkable_grant"
  RENAME CONSTRAINT "framework_resparkable_grant_userId_fkey"
  TO "framework_resparkable_grant_spaceId_fkey";
ALTER TABLE "framework_resparkable_job"
  RENAME CONSTRAINT "framework_resparkable_job_userId_fkey"
  TO "framework_resparkable_job_spaceId_fkey";
ALTER TABLE "framework_resparkable_link"
  RENAME CONSTRAINT "framework_resparkable_link_userId_fkey"
  TO "framework_resparkable_link_spaceId_fkey";
ALTER TABLE "framework_resparkable_project"
  RENAME CONSTRAINT "framework_resparkable_project_userId_fkey"
  TO "framework_resparkable_project_spaceId_fkey";
ALTER TABLE "framework_resparkable_review"
  RENAME CONSTRAINT "framework_resparkable_review_userId_fkey"
  TO "framework_resparkable_review_spaceId_fkey";
ALTER TABLE "framework_resparkable_share_link"
  RENAME CONSTRAINT "framework_resparkable_share_link_userId_fkey"
  TO "framework_resparkable_share_link_spaceId_fkey";
ALTER TABLE "framework_resparkable_tag"
  RENAME CONSTRAINT "framework_resparkable_tag_userId_fkey"
  TO "framework_resparkable_tag_spaceId_fkey";
ALTER TABLE "framework_resparkable_task_tag"
  RENAME CONSTRAINT "framework_resparkable_task_tag_userId_fkey"
  TO "framework_resparkable_task_tag_spaceId_fkey";
ALTER TABLE "framework_resparkable_task"
  RENAME CONSTRAINT "framework_resparkable_task_userId_fkey"
  TO "framework_resparkable_task_spaceId_fkey";
ALTER TABLE "framework_resparkable_thought"
  RENAME CONSTRAINT "framework_resparkable_thought_userId_fkey"
  TO "framework_resparkable_thought_spaceId_fkey";
ALTER TABLE "framework_resparkable_time_block"
  RENAME CONSTRAINT "framework_resparkable_time_block_userId_fkey"
  TO "framework_resparkable_time_block_spaceId_fkey";

-- ── 5. The parent's new columns (§23.2 for kind/ownerUserId, §24.1 for the rest).
--       Constant defaults only, so this is a catalog write.
ALTER TABLE "framework_resparkable_space"
  ADD COLUMN "kind"        VARCHAR(16) NOT NULL DEFAULT 'personal',
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "name"        VARCHAR(120),
  ADD COLUMN "slug"        VARCHAR(64),
  ADD COLUMN "archivedAt"  TIMESTAMP(3);

-- ── 6. `createdByUserId` on every satellite (§23.5). Nullable, no default, no
--       index: §23.10 forbids any aggregate over members, and the absent index is
--       what makes the leaderboard awkward as well as forbidden.
ALTER TABLE "framework_resparkable_area" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_board" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_board_card" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_checklist_item" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_comment" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_credit_account" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_credit_ledger_entry" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_document" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_embedding" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_entity" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_event" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_goal" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_grant" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_job" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_link" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_project" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_review" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_share_link" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_tag" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_task" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_task_tag" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_thought" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "framework_resparkable_time_block" ADD COLUMN "createdByUserId" TEXT;

-- ── 7. The one backfill, and the only write to a pre-existing row in this file.
--       A personal space's key value IS a user id today, which is the whole
--       reason this migration renames rather than re-points at `id`.
--
--       `isDefault = true` is not in §23.2 and is required: without it every
--       existing user ends up with no default workspace, and §24.2 is explicit
--       that a user may not have none.
UPDATE "framework_resparkable_space"
   SET "ownerUserId" = "spaceId",
       "kind"        = 'personal',
       "isDefault"   = true;

-- ── 8. B1, on its new column. AFTER the backfill or validation fails on a
--       non-empty table. It cannot fail on real data: the constraint dropped at
--       step 1 already guaranteed every key value is a live user id.
--
--       ⚠️ Hand-written, unmodellable, and THE GDPR CASCADE. Probe B1 asserts
--       both its existence and its ON DELETE action on this column. A group space
--       has "ownerUserId" NULL and is therefore, correctly, not reachable here at
--       all: that is what stops one member closing their account and taking a
--       shared workspace with them.
ALTER TABLE "framework_resparkable_space"
  ADD CONSTRAINT "framework_resparkable_space_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 8b. B12: the ownership invariant, enforced by the database.
--
--       §23.6 and test 13b ask for this as a SCHEMA-level invariant rather than
--       a fixture assertion, and the reason became concrete during phase 45: a
--       personal space whose `ownerUserId` is NULL is not reachable by the
--       cascade above, so it is a brain no erasure can ever remove. Nothing
--       errors. It is an Art. 17 hole that looks exactly like a working install.
--
--       Two writers created one within an hour of the column existing (the
--       space service, and a smoke fixture writing Prisma directly), which is
--       the argument for a constraint rather than a convention: the column is
--       nullable BECAUSE a group space must have it NULL, so no NOT NULL can
--       express the rule and every writer would otherwise have to remember it.
--
--       The other direction matters as much and is the half §23.6 emphasises: a
--       group space that acquires an `ownerUserId` through some later
--       convenience is a whole shared workspace destroyed when one member
--       closes their account.
ALTER TABLE "framework_resparkable_space"
  ADD CONSTRAINT "framework_resparkable_space_owner_kind_coherent"
  CHECK (
    ("kind" = 'personal' AND "ownerUserId" IS NOT NULL)
    OR ("kind" = 'group' AND "ownerUserId" IS NULL)
  );

-- ── 9. Owner lookup. A PLAIN index, deliberately not unique: that absence is the
--       entire schema-level cost of several workspaces per owner (§24.1).
CREATE INDEX "framework_resparkable_space_ownerUserId_idx"
  ON "framework_resparkable_space"("ownerUserId");

-- ── 10. B10 — at most one live default workspace per owner (§24.1).
--
--       ⚠️ Partial unique indexes are not expressible in Prisma, so this joins the
--       raw-SQL objects `migrate dev` re-drops on every diff. Probe B10 asserts
--       its definition, not merely its name: a plain non-unique non-partial index
--       called this would satisfy `indexExists` and enforce nothing.
--
--       "ownerUserId" is nullable and NULLs never collide in a unique index, so
--       group spaces are unconstrained here by design. Phase 46 adds the groupId
--       sibling.
CREATE UNIQUE INDEX "idx_framework_resparkable_space_one_default_per_owner"
  ON "framework_resparkable_space" ("ownerUserId")
  WHERE "isDefault" AND "archivedAt" IS NULL;

-- ── 11. The `createdByUserId` cascade, 23 times.
--
--       ⚠️ All hand-written and unmodellable, for the reason B1/B8/B9 are: `User`
--       is Sunrise-owned and Resparkable must not add a relation field there.
--       Probe B11 covers all 23 at once rather than adding 23 probes.
--
--       SetNull, never Cascade. Erasing a member removes their authorship and
--       leaves the group's content, because that content is the group's. Cascade
--       here would let one departing member silently delete a term's worth of
--       shared revision material.
ALTER TABLE "framework_resparkable_area"
  ADD CONSTRAINT "framework_resparkable_area_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_board"
  ADD CONSTRAINT "framework_resparkable_board_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_board_card"
  ADD CONSTRAINT "framework_resparkable_board_card_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_checklist_item"
  ADD CONSTRAINT "framework_resparkable_checklist_item_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_comment"
  ADD CONSTRAINT "framework_resparkable_comment_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_credit_account"
  ADD CONSTRAINT "framework_resparkable_credit_account_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_credit_ledger_entry"
  ADD CONSTRAINT "framework_resparkable_credit_ledger_entry_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_document"
  ADD CONSTRAINT "framework_resparkable_document_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_embedding"
  ADD CONSTRAINT "framework_resparkable_embedding_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_entity"
  ADD CONSTRAINT "framework_resparkable_entity_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_event"
  ADD CONSTRAINT "framework_resparkable_event_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_goal"
  ADD CONSTRAINT "framework_resparkable_goal_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_grant"
  ADD CONSTRAINT "framework_resparkable_grant_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_job"
  ADD CONSTRAINT "framework_resparkable_job_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_link"
  ADD CONSTRAINT "framework_resparkable_link_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_project"
  ADD CONSTRAINT "framework_resparkable_project_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_review"
  ADD CONSTRAINT "framework_resparkable_review_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_share_link"
  ADD CONSTRAINT "framework_resparkable_share_link_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_tag"
  ADD CONSTRAINT "framework_resparkable_tag_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_task"
  ADD CONSTRAINT "framework_resparkable_task_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_task_tag"
  ADD CONSTRAINT "framework_resparkable_task_tag_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_thought"
  ADD CONSTRAINT "framework_resparkable_thought_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "framework_resparkable_time_block"
  ADD CONSTRAINT "framework_resparkable_time_block_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 12. The scheduled-run scope key (§24.2), written ADDITIVELY.
--
--       §24.2 says the key becomes `resparkableSpaceId`. Replacing it outright
--       opens a window at deploy, before the new code is on every pod, in which an
--       old reader finds nothing and silently resolves no owner: a skipped bill,
--       or a 04:30 briefing where every capability throws with nothing surfacing
--       it. That is what `20260805120000_resparkable_schedule_owner_scope` was
--       written about. Both keys are written and either is read, so a
--       pre-migration row still resolves; deleting the old one is a later phase.
UPDATE "ai_workflow_schedule"
   SET "scope" = "scope" || jsonb_build_object('resparkableSpaceId', "scope"->>'resparkableUserId')
 WHERE "scope" ? 'resparkableUserId';

UPDATE "ai_workflow_execution"
   SET "scope" = "scope" || jsonb_build_object('resparkableSpaceId', "scope"->>'resparkableUserId')
 WHERE "scope" ? 'resparkableUserId';

UPDATE "ai_workflow_trigger"
   SET "scope" = "scope" || jsonb_build_object('resparkableSpaceId', "scope"->>'resparkableUserId')
 WHERE "scope" ? 'resparkableUserId';
