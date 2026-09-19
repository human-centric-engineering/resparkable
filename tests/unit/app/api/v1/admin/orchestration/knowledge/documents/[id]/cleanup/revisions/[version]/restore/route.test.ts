import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockGetEditLockState,
  mockWriteCleanupContent,
  mockFindFirst,
  mockFindUnique,
  mockLogAdminAction,
} = vi.hoisted(() => ({
  mockGetEditLockState: vi.fn(),
  mockWriteCleanupContent: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
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
    aiKnowledgeDocument: {
      findFirst: mockFindFirst,
    },
    aiKnowledgeDocumentRevision: {
      findUnique: mockFindUnique,
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
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/[version]/restore/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ADMIN_ID matches the hardcoded id returned by mockAuthenticatedUser / mockAdminUser.
// The route compares lockState.heldBy to session.user.id. Using ADMIN_ID for heldBy
// means the happy-path tests clear the lock check.
// DOC_ID must differ from ADMIN_ID to avoid accidental CUID collisions.
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';

const REVISION_CONTENT = 'Restored content body for version 3.';

function req(docId: string, version: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${docId}/cleanup/revisions/${version}/restore`,
    { method: 'POST' }
  );
}

function params(id: string, version: string) {
  return { params: Promise.resolve({ id, version }) };
}

describe('POST /cleanup/revisions/[version]/restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Default: lock held by the current admin — happy-path passes lock check
    mockGetEditLockState.mockResolvedValue({
      heldBy: ADMIN_ID,
      acquiredAt: new Date(),
      active: true,
    });
    // Default: doc exists and is in cleaning status, owned by the admin
    mockFindFirst.mockResolvedValue({ fileName: 'doc.md' });
    // Default: revision exists
    mockFindUnique.mockResolvedValue({
      id: 'rev3',
      documentId: DOC_ID,
      version: 3,
      content: REVISION_CONTENT,
      source: 'human_full',
      actorId: ADMIN_ID,
      sectionMarker: null,
      instructions: null,
      createdAt: new Date(),
    });
    mockWriteCleanupContent.mockResolvedValue(undefined);
    mockLogAdminAction.mockReturnValue(undefined);
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));
      expect(r.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid document CUID', async () => {
      const r = await POST(req(INVALID_ID, '3'), params(INVALID_ID, '3'));
      expect(r.status).toBe(400);
    });

    it('400 when version is a non-numeric string', async () => {
      const r = await POST(req(DOC_ID, 'abc'), params(DOC_ID, 'abc'));
      expect(r.status).toBe(400);
    });

    it('400 when version is negative', async () => {
      const r = await POST(req(DOC_ID, '-1'), params(DOC_ID, '-1'));
      expect(r.status).toBe(400);
    });

    it('400 when version is zero', async () => {
      const r = await POST(req(DOC_ID, '0'), params(DOC_ID, '0'));
      expect(r.status).toBe(400);
    });
  });

  describe('lock guard', () => {
    it('423 LOCK_HELD when another admin owns the lock and writeCleanupContent is NOT called', async () => {
      // Arrange: lock held by a different admin
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'other-admin-id',
        acquiredAt: new Date(),
        active: true,
      });

      // Act
      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));

      // Assert full error envelope and side-effect guard
      expect(r.status).toBe(423);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('LOCK_HELD');
      expect(body.error.details.heldBy).toEqual(['other-admin-id']);
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    });
  });

  describe('document state guard', () => {
    it('400 when doc is not in cleaning status or not owned by the calling user', async () => {
      // findFirst returns null → doc missing, wrong status, or different owner
      mockFindFirst.mockResolvedValue(null);

      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));
      expect(r.status).toBe(400);
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    });
  });

  describe('revision lookup', () => {
    it('404 REVISION_NOT_FOUND when the version does not exist for the document', async () => {
      // findUnique by composite key returns null
      mockFindUnique.mockResolvedValue(null);

      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('REVISION_NOT_FOUND');
    });
  });

  describe('happy path', () => {
    it('calls writeCleanupContent with source="restore" and the literal instructions template', async () => {
      // Arrange: version 5 so we can verify the template interpolation
      mockFindUnique.mockResolvedValue({
        id: 'rev5',
        documentId: DOC_ID,
        version: 5,
        content: 'Content from v5.',
        source: 'human_full',
        actorId: ADMIN_ID,
        sectionMarker: null,
        instructions: null,
        createdAt: new Date(),
      });

      // Act
      const r = await POST(req(DOC_ID, '5'), params(DOC_ID, '5'));

      // Assert: source is 'restore' (NOT 'capability:restore') and instructions match template
      expect(r.status).toBe(200);
      expect(mockWriteCleanupContent).toHaveBeenCalledWith(DOC_ID, 'Content from v5.', {
        source: 'restore',
        actorId: ADMIN_ID,
        instructions: 'Restored from v5',
      });
    });

    it('returns { documentId, restoredFromVersion, newContent }', async () => {
      // Act
      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));

      // Assert response shape
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        documentId: DOC_ID,
        restoredFromVersion: 3,
        newContent: REVISION_CONTENT,
      });
    });

    it('writes an admin-audit entry with action knowledge_document.cleanup_restore and metadata.restoredFromVersion', async () => {
      // Arrange: version 3 (default mockFindUnique already set to v3)
      const r = await POST(req(DOC_ID, '3'), params(DOC_ID, '3'));

      expect(r.status).toBe(200);
      expect(mockLogAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'knowledge_document.cleanup_restore',
          entityType: 'knowledge_document',
          entityId: DOC_ID,
          metadata: expect.objectContaining({ restoredFromVersion: 3 }),
        })
      );
    });
  });
});
