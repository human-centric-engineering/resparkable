import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockGetEditLockState, mockWriteCleanupContent, mockFindFirst } = vi.hoisted(() => ({
  mockGetEditLockState: vi.fn(),
  mockWriteCleanupContent: vi.fn(),
  mockFindFirst: vi.fn(),
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
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/content/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ADMIN_ID matches the hardcoded id in mockAuthenticatedUser. The route
// compares lockState.heldBy to session.user.id — they must agree for the
// happy-path tests to clear the lock check.
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const ORIGINAL = 'original cleanup content';
const ORIGINAL_FINGERPRINT = createHash('sha256').update(ORIGINAL).digest('hex');

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/content`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /cleanup/content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockGetEditLockState.mockResolvedValue({
      heldBy: ADMIN_ID,
      acquiredAt: new Date(),
      active: true,
    });
    mockFindFirst.mockResolvedValue({
      processedContent: ORIGINAL,
      originalContent: 'whatever',
      fileName: 'test.md',
    });
    mockWriteCleanupContent.mockResolvedValue(undefined);
  });

  describe('auth + validation', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await POST(
        req({ content: 'x', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await POST(
        req({ content: 'x', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(403);
    });

    it('400 on invalid CUID', async () => {
      const r = await POST(
        req({ content: 'x', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params('not-cuid')
      );
      expect(r.status).toBe(400);
    });

    it('400 when expectedFingerprint is not a SHA-256 hex digest', async () => {
      const r = await POST(req({ content: 'x', expectedFingerprint: 'too-short' }), params(DOC_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('lock', () => {
    it('423 LOCK_HELD when another admin owns the lock', async () => {
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'other-admin',
        acquiredAt: new Date(),
        active: true,
      });
      const r = await POST(
        req({ content: 'new', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(423);
      const body = await r.json();
      expect(body.error.code).toBe('LOCK_HELD');
      expect(body.error.details.heldBy).toEqual(['other-admin']);
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    });

    it('proceeds when no lock is held', async () => {
      mockGetEditLockState.mockResolvedValue({ heldBy: null, acquiredAt: null, active: false });
      const r = await POST(
        req({ content: 'new', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(200);
    });
  });

  describe('document state', () => {
    it('400 when the doc is not in cleaning status or not owned by user', async () => {
      mockFindFirst.mockResolvedValue(null);
      const r = await POST(
        req({ content: 'new', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(400);
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    });
  });

  describe('fingerprint', () => {
    it('409 CONTENT_MISMATCH when fingerprint does not match current content', async () => {
      const wrongFp = createHash('sha256').update('different content').digest('hex');
      const r = await POST(req({ content: 'new', expectedFingerprint: wrongFp }), params(DOC_ID));
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.error.code).toBe('CONTENT_MISMATCH');
      expect(body.error.details.currentContent).toEqual([ORIGINAL]);
      expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('writes with source=human_full and returns the new fingerprint', async () => {
      const r = await POST(
        req({ content: 'edited content', expectedFingerprint: ORIGINAL_FINGERPRINT }),
        params(DOC_ID)
      );
      expect(r.status).toBe(200);
      expect(mockWriteCleanupContent).toHaveBeenCalledWith(DOC_ID, 'edited content', {
        source: 'human_full',
        actorId: ADMIN_ID,
      });
      const body = await r.json();
      expect(body.data.fingerprint).toBe(
        createHash('sha256').update('edited content').digest('hex')
      );
    });
  });
});
