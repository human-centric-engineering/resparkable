/**
 * Admin Orchestration — Cleanup whole-document edit
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/content
 *
 * Body: { content: string, expectedFingerprint: string }
 *
 * Whole-document inline edit. Requires the edit lock to be held by the
 * caller (423 otherwise). Computes SHA-256 of current processedContent
 * and compares against expectedFingerprint; rejects with 409 + current
 * content on mismatch. Writes a `human_full` revision through the
 * shared writeCleanupContent so history stays unified with capability
 * mutations.
 *
 * Authentication: Admin role required.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { writeCleanupContent } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const bodySchema = z.object({
  content: z.string().max(5_000_000), // 5 MB cap — same shape as the upload route's text guards
  expectedFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'expectedFingerprint must be a SHA-256 hex digest'),
});

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const log = await getRouteLogger(request);

  const { id: rawId } = await params;
  const parsedId = cuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  const documentId = parsedId.data;

  const body = await validateRequestBody(request, bodySchema);

  // Lock check first — 423 takes precedence over fingerprint mismatch.
  const lockState = await getEditLockState(documentId);
  if (lockState.active && lockState.heldBy !== session.user.id) {
    return errorResponse('Document is being edited by another admin', {
      code: 'LOCK_HELD',
      status: 423,
      details: { heldBy: [lockState.heldBy ?? 'unknown'] },
    });
  }

  const doc = await prisma.aiKnowledgeDocument.findFirst({
    where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
    select: { processedContent: true, originalContent: true, fileName: true },
  });
  if (!doc) {
    throw new ValidationError(
      'Document not found, not owned by this user, or not in cleaning status'
    );
  }

  const currentContent = doc.processedContent ?? doc.originalContent ?? '';
  const currentFingerprint = fingerprint(currentContent);
  if (currentFingerprint !== body.expectedFingerprint) {
    return errorResponse('Content has changed since edit began', {
      code: 'CONTENT_MISMATCH',
      status: 409,
      details: {
        currentContent: [currentContent],
        currentFingerprint: [currentFingerprint],
      },
    });
  }

  await writeCleanupContent(documentId, body.content, {
    source: 'human_full',
    actorId: session.user.id,
  });

  log.info('Cleanup whole-doc edit applied', {
    documentId,
    adminId: session.user.id,
    charsBefore: currentContent.length,
    charsAfter: body.content.length,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'knowledge_document.cleanup_edit',
    entityType: 'knowledge_document',
    entityId: documentId,
    entityName: doc.fileName,
    metadata: { scope: 'whole-doc', charsAfter: body.content.length },
    clientIp: clientIP,
  });

  return successResponse({
    documentId,
    fingerprint: fingerprint(body.content),
    charsAfter: body.content.length,
  });
});
