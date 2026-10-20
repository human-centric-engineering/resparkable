-- ─────────────────────────────────────────────────────────────────────────────
-- Resparkable ledger: backfill the books' category on group rows written before
-- phase 62.
--
-- Before phase 62 a group's pool was its only account, so a group-space row's
-- meaning followed from its kind and its author: a run nobody started was a
-- running cost, a run a member started was shared activity, and a transfer in
-- was a top-up. Writing that down now, while the author ids are still on the
-- rows, means a later erasure (which nulls them) cannot turn a member's spend
-- into a running cost in the books. Operator grants stay null: the books read
-- them from their kind as nobody's.
--
-- Rows written since phase 62 carry their category already and are not touched.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "framework_resparkable_credit_ledger_entry" AS l
   SET "booksCategory" = CASE
         WHEN l."kind" = 'agent_spend' AND l."createdByUserId" IS NULL THEN 'runningCosts'
         WHEN l."kind" = 'agent_spend' THEN 'sharedActivity'
         ELSE 'topUps'
       END
  FROM "framework_resparkable_space" AS s
 WHERE l."spaceId" = s."spaceId"
   AND s."kind" = 'group'
   AND l."booksCategory" IS NULL
   AND l."memberUserId" IS NULL
   AND l."kind" IN ('agent_spend', 'transfer_in');
