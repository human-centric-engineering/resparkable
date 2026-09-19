-- Give the Document Clean Up audit trail a real FK to `user`, with
-- onDelete: SetNull matching AiKnowledgeDocument.uploadedBy — the revision
-- and pending-change rows are retained audit history, not personal data, so
-- deleting the user should sever attribution rather than take the rows.
--
-- Without this, `actorId` was a bare String with no relation: the privacy
-- guard's User-relation scan couldn't see it (it isn't named userId /
-- createdBy / uploadedBy / ownerId / actorUserId / subjectUserId either), so
-- it was neither cascaded/nulled on erasure nor listed for subject export.

-- AiKnowledgeDocumentPendingChange.actorId must be nullable for SET NULL.
ALTER TABLE "ai_knowledge_document_pending_change" ALTER COLUMN "actorId" DROP NOT NULL;

ALTER TABLE "ai_knowledge_document_revision"
  ADD CONSTRAINT "ai_knowledge_document_revision_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_knowledge_document_pending_change"
  ADD CONSTRAINT "ai_knowledge_document_pending_change_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
