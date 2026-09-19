-- Document Clean Up flow: store the original parsed text + the in-progress
-- cleaned version on the document row so cleanup capabilities can mutate
-- across multiple chat turns without touching chunks (which are written
-- only on finalise). Both columns are nullable — docs that bypass cleanup
-- leave them null; finalised docs may have them cleared to reclaim storage.
ALTER TABLE "ai_knowledge_document" ADD COLUMN "originalContent" TEXT;
ALTER TABLE "ai_knowledge_document" ADD COLUMN "processedContent" TEXT;

-- Extend the status CHECK constraint to allow 'cleaning'. The constraint is
-- managed in raw SQL (Prisma cannot model it) — see the PRISMA-SCHEMA DRIFT
-- WARNING block on AiKnowledgeDocument in
-- prisma/schema/orchestration-knowledge.prisma. Drop-then-recreate is the
-- only way to widen a CHECK in PostgreSQL.
ALTER TABLE "ai_knowledge_document"
  DROP CONSTRAINT IF EXISTS "ai_knowledge_document_status_lowercase";
ALTER TABLE "ai_knowledge_document"
  ADD CONSTRAINT "ai_knowledge_document_status_lowercase"
  CHECK (status IN ('processing', 'ready', 'failed', 'pending_review', 'cleaning'));
