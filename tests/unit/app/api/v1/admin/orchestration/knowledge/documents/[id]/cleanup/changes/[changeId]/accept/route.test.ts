import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// vi.hoisted so refs exist when vi.mock factories run
const {
  mockGetEditLockState,
  mockWriteCleanupContent,
  mockFindFirstDoc,
  mockFindUniqueDoc,
  mockFindFirstChange,
  mockDeleteChange,
  mockLogAdminAction,
} = vi.hoisted(() => ({
  mockGetEditLockState: vi.fn(),
  mockWriteCleanupContent: vi.fn(),
  mockFindFirstDoc: vi.fn(),
  mockFindUniqueDoc: vi.fn(),
  mockFindFirstChange: vi.fn(),
  mockDeleteChange: vi.fn(),
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
    aiKnowledgeDocument: { findFirst: mockFindFirstDoc, findUnique: mockFindUniqueDoc },
    aiKnowledgeDocumentPendingChange: {
      findFirst: mockFindFirstChange,
      delete: mockDeleteChange,
    },
  },
}));

vi.mock('@/lib/orchestration/knowledge/edit-lock', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/knowledge/edit-lock')>(
    '@/lib/orchestration/knowledge/edit-lock'
  );
  return { ...actual, getEditLockState: mockGetEditLockState };
});

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', () => ({
  writeCleanupContent: mockWriteCleanupContent,
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mockLogAdminAction,
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/accept/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ADMIN_ID matches the hardcoded id in mockAuthenticatedUser. The route
// compares lockState.heldBy to session.user.id — they must agree for the
// happy-path tests to clear the lock check.
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const CHANGE_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

const mockChange = {
  id: CHANGE_ID,
  documentId: DOC_ID,
  source: 'rewrite_with_llm',
  afterContent: 'rewritten content',
  sectionMarker: 'Introduction',
  instructions: 'Make it cleaner',
  actorId: ADMIN_ID,
  beforeContent: 'original content',
};

function req(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/changes/${CHANGE_ID}/accept`,
    { method: 'POST' }
  );
}

function params(id: string, changeId: string) {
  return { params: Promise.resolve({ id, changeId }) };
}

describe('POST /cleanup/changes/:changeId/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Happy-path defaults: caller owns the lock
    mockGetEditLockState.mockResolvedValue({
      heldBy: ADMIN_ID,
      acquiredAt: new Date(),
      active: true,
    });
    mockFindFirstDoc.mockResolvedValue({ fileName: 'test.md' });
    // Happy-path default: processedContent still matches the change's
    // beforeContent, so the freshness guard passes.
    mockFindUniqueDoc.mockResolvedValue({
      processedContent: mockChange.beforeContent,
      originalContent: null,
    });
    mockFindFirstChange.mockResolvedValue(mockChange);
    mockWriteCleanupContent.mockResolvedValue(undefined);
    mockDeleteChange.mockResolvedValue(mockChange);
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

  describe('lock check', () => {
    it('423 LOCK_HELD when another admin owns the lock', async () => {
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'other-admin',
        acquiredAt: new Date(),
        active: true,
      });

      const r = await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(r.status).toBe(423);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('LOCK_HELD');
      expect(body.error.details.heldBy).toEqual(['other-admin']);
      // No content write or DB delete must occur when lock is held
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
      expect(mockDeleteChange).not.toHaveBeenCalled();
    });
  });

  describe('document state', () => {
    it('400 when doc is not in cleaning status or not owned by the caller', async () => {
      mockFindFirstDoc.mockResolvedValue(null);
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('content freshness', () => {
    it('409 CHANGE_STALE when processedContent no longer matches change.beforeContent', async () => {
      mockFindUniqueDoc.mockResolvedValue({
        processedContent: 'someone else already edited this',
        originalContent: null,
      });

      const r = await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CHANGE_STALE');
      // Must not apply the change or delete the pending row on a stale mismatch
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
      expect(mockDeleteChange).not.toHaveBeenCalled();
    });
  });

  describe('pending change lookup', () => {
    it('404 CHANGE_NOT_FOUND when the pending row does not exist', async () => {
      mockFindFirstChange.mockResolvedValue(null);
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CHANGE_NOT_FOUND');
    });
  });

  describe('happy path', () => {
    it('calls writeCleanupContent with capability-prefixed source, actorId, sectionMarker, instructions', async () => {
      await POST(req(), params(DOC_ID, CHANGE_ID));

      // Route must transform change.source → capability:<slug> — not pass through the raw string
      expect(mockWriteCleanupContent).toHaveBeenCalledWith(
        DOC_ID,
        mockChange.afterContent,
        expect.objectContaining({
          source: `capability:${mockChange.source}`,
          actorId: ADMIN_ID,
          sectionMarker: mockChange.sectionMarker,
          instructions: mockChange.instructions,
        })
      );
    });

    it('deletes the pending change row exactly once with { where: { id: changeId } }', async () => {
      await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(mockDeleteChange).toHaveBeenCalledTimes(1);
      expect(mockDeleteChange).toHaveBeenCalledWith({ where: { id: CHANGE_ID } });
    });

    it('returns { accepted: true, changeId, newContent: change.afterContent }', async () => {
      const r = await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        accepted: true,
        changeId: CHANGE_ID,
        newContent: mockChange.afterContent,
      });
    });

    it('logs admin-audit knowledge_document.cleanup_accept with source and sectionMarker metadata', async () => {
      await POST(req(), params(DOC_ID, CHANGE_ID));

      expect(mockLogAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'knowledge_document.cleanup_accept',
          entityType: 'knowledge_document',
          entityId: DOC_ID,
          metadata: expect.objectContaining({
            source: mockChange.source,
            sectionMarker: mockChange.sectionMarker,
          }),
        })
      );
    });
  });
});
