-- Immutable, append-only history of processedContent mutations during a
-- Document Clean Up session. See lib/orchestration/knowledge/revisions.ts
-- for the writer + version-allocation contract, and
-- prisma/schema/orchestration-knowledge.prisma for the model + source
-- taxonomy.
CREATE TABLE "ai_knowledge_document_revision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorId" TEXT,
    "sectionMarker" TEXT,
    "instructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_document_revision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_knowledge_document_revision_documentId_createdAt_idx"
  ON "ai_knowledge_document_revision"("documentId", "createdAt");

CREATE UNIQUE INDEX "ai_knowledge_document_revision_documentId_version_key"
  ON "ai_knowledge_document_revision"("documentId", "version");

-- onDelete: Cascade so doc deletion (e.g. cleanup discard, GDPR erasure)
-- takes its revision history.
ALTER TABLE "ai_knowledge_document_revision"
  ADD CONSTRAINT "ai_knowledge_document_revision_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
