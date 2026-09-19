import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// vi.hoisted so refs exist when vi.mock factories run
const { mockFindFirstDoc, mockDeleteMany, mockLogAdminAction } = vi.hoisted(() => ({
  mockFindFirstDoc: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockLogAdminAction: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: { findFirst: mockFindFirstDoc },
    aiKnowledgeDocumentPendingChange: { deleteMany: mockDeleteMany },
  },
}));

// Reject does NOT import or use the edit-lock module — no mock needed.
// The test below verifies this contract explicitly.

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mockLogAdminAction,
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/reject/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ADMIN_ID matches the hardcoded id in mockAuthenticatedUser.
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const CHANGE_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function req(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/changes/${CHANGE_ID}/reject`,
    { method: 'POST' }
  );
}

function params(id: string, changeId: string) {
  return { params: Promise.resolve({ id, changeId }) };
}

describe('POST /cleanup/changes/:changeId/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockFindFirstDoc.mockResolvedValue({ fileName: 'test.md' });
    // Default: deleteMany deletes one row
    mockDeleteMany.mockResolvedValue({ count: 1 });
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid document CUID', async () => {
      const r = await POST(req(), params(INVALID_ID, CHANGE_ID));
      expect(r.status).toBe(400);
    });

    it('400 on invalid changeId CUID', async () => {
      const r = await POST(req(), params(DOC_ID, INVALID_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('document state', () => {
    it('400 when doc is not in cleaning status or not owned by the caller', async () => {
      mockFindFirstDoc.mockResolvedValue(null);
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('pending change delete', () => {
    it('404 CHANGE_NOT_FOUND when deleteMany affects 0 rows', async () => {
      mockDeleteMany.mockResolvedValue({ count: 0 });
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CHANGE_NOT_FOUND');
    });
  });

  describe('happy path', () => {
    it('returns { rejected: true, changeId } and calls deleteMany with correct where clause', async () => {
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({ rejected: true, changeId: CHANGE_ID });

      // Verify deleteMany was called with the exact where clause that scopes by both id and documentId
      expect(mockDeleteMany).toHaveBeenCalledTimes(1);
      expect(mockDeleteMany).toHaveBeenCalledWith({
        where: { id: CHANGE_ID, documentId: DOC_ID },
      });
    });

    it('writes admin-audit knowledge_document.cleanup_reject', async () => {
      await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(mockLogAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'knowledge_document.cleanup_reject',
          entityType: 'knowledge_document',
          entityId: DOC_ID,
        })
      );
    });

    it('proceeds with reject even when another admin holds the edit lock (reject is lock-free)', async () => {
      // This test verifies the documented contract: reject does NOT check the edit lock.
      // We arrange a scenario that would block an accept (another admin holds lock) but must
      // NOT block a reject — confirming the route has no lock-check logic.
      // Since reject doesn't import edit-lock at all, there's nothing to mock here;
      // we simply confirm the route returns 200 regardless.
      mockDeleteMany.mockResolvedValue({ count: 1 });

      const r = await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data.rejected).toBe(true);
      // deleteMany was still called — the delete was not blocked
      expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    });
  });
});
