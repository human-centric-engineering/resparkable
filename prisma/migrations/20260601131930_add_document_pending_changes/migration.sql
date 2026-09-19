-- Pending LLM-rewrite proposals awaiting human Accept / Reject. Written by
-- rewrite_with_llm and rewrite_section_with_llm — see the model header in
-- prisma/schema/orchestration-knowledge.prisma for the contract.
CREATE TABLE "ai_knowledge_document_pending_change" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "beforeContent" TEXT NOT NULL,
    "afterContent" TEXT NOT NULL,
    "sectionMarker" TEXT,
    "instructions" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_document_pending_change_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_knowledge_document_pending_change_documentId_createdAt_idx"
  ON "ai_knowledge_document_pending_change"("documentId", "createdAt");

ALTER TABLE "ai_knowledge_document_pending_change"
  ADD CONSTRAINT "ai_knowledge_document_pending_change_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
