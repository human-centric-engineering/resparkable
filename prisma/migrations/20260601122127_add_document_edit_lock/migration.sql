-- Cooperative single-writer edit lock for Document Clean Up co-authoring.
-- See lib/orchestration/knowledge/edit-lock.ts for TTL + acquire semantics.
-- Both columns null when no admin is editing; populated together by
-- acquireEditLock(); cleared together by releaseEditLock().
ALTER TABLE "ai_knowledge_document"
  ADD COLUMN "editLockHolder" TEXT,
  ADD COLUMN "editLockAcquiredAt" TIMESTAMP(3);
