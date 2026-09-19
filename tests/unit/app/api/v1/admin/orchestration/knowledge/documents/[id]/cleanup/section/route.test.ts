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
  prisma: { aiKnowledgeDocument: { findFirst: mockFindFirst } },
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
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/section/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { detectSections } from '@/lib/orchestration/knowledge/section-detection';

// ADMIN_ID matches the hardcoded id in mockAuthenticatedUser. The route
// compares lockState.heldBy to session.user.id — they must agree for the
// happy-path tests to clear the lock check.
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

// Two-heading doc — detectSections splits it into two sections.
const FULL_DOC = '# Intro\nfirst body\n# Body\nsecond body';
const INTRO_SECTION_BODY = '# Intro\nfirst body\n';
const INTRO_FP = createHash('sha256').update(INTRO_SECTION_BODY).digest('hex');
// Sections are addressed by their detectSections id, not their marker. Derived
// from the real detector so the test breaks if the id scheme changes.
const INTRO_ID = detectSections(FULL_DOC)[0].id;

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/section`,
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

describe('POST /cleanup/section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockGetEditLockState.mockResolvedValue({
      heldBy: ADMIN_ID,
      acquiredAt: new Date(),
      active: true,
    });
    mockFindFirst.mockResolvedValue({
      processedContent: FULL_DOC,
      originalContent: 'irrelevant',
      fileName: 'test.md',
    });
    mockWriteCleanupContent.mockResolvedValue(undefined);
  });

  describe('document id validation', () => {
    it('400 on invalid document CUID — cuidSchema rejects the id before any DB call', async () => {
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: INTRO_FP }),
        params('not-a-cuid')
      );
      expect(r.status).toBe(400);
      // Confirm the DB was not called — the route must short-circuit on id validation
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('document not found', () => {
    it('400 when doc is not found, not owned by caller, or not in cleaning status', async () => {
      mockFindFirst.mockResolvedValue(null);
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: INTRO_FP }),
        params(DOC_ID)
      );
      expect(r.status).toBe(400);
    });
  });

  describe('auth + validation', () => {
    it('401 unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: INTRO_FP }),
        params(DOC_ID)
      );
      expect(r.status).toBe(401);
    });

    it('403 non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: INTRO_FP }),
        params(DOC_ID)
      );
      expect(r.status).toBe(403);
    });
  });

  describe('lock', () => {
    it('423 when held by another admin', async () => {
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'other-admin',
        acquiredAt: new Date(),
        active: true,
      });
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: INTRO_FP }),
        params(DOC_ID)
      );
      expect(r.status).toBe(423);
    });
  });

  describe('section not found', () => {
    it('404 SECTION_NOT_FOUND when the id matches nothing', async () => {
      const r = await POST(
        req({
          sectionId: 'deadbeef',
          content: 'x',
          expectedFingerprint: INTRO_FP,
        }),
        params(DOC_ID)
      );
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.error.code).toBe('SECTION_NOT_FOUND');
    });
  });

  describe('fingerprint', () => {
    it('409 when section body has changed since edit began', async () => {
      const wrongFp = createHash('sha256').update('stale').digest('hex');
      const r = await POST(
        req({ sectionId: INTRO_ID, content: 'x', expectedFingerprint: wrongFp }),
        params(DOC_ID)
      );
      expect(r.status).toBe(409);
      const body = await r.json();
      expect(body.error.code).toBe('CONTENT_MISMATCH');
      expect(body.error.details.currentBody).toEqual([INTRO_SECTION_BODY]);
    });
  });

  describe('duplicate markers', () => {
    // Markers are labels and repeat within a document; only the id
    // distinguishes them. Addressing by marker spliced the FIRST match.
    it('edits the second of two identically-marked sections', async () => {
      const dupDoc = '# Intro\nfirst body\n# Intro\nsecond body';
      mockFindFirst.mockResolvedValue({
        processedContent: dupDoc,
        originalContent: 'irrelevant',
        fileName: 'test.md',
      });
      const second = detectSections(dupDoc)[1];
      expect(second.marker).toBe(detectSections(dupDoc)[0].marker);

      const r = await POST(
        req({
          sectionId: second.id,
          content: '# Intro\nsecond body rewritten',
          expectedFingerprint: createHash('sha256').update(second.body).digest('hex'),
        }),
        params(DOC_ID)
      );
      expect(r.status).toBe(200);
      // The FIRST 'Intro' section must be untouched.
      expect(mockWriteCleanupContent.mock.calls[0][1]).toBe(
        '# Intro\nfirst body\n# Intro\nsecond body rewritten'
      );
    });
  });

  describe('happy path', () => {
    it('splices the new body into the doc and writes a human_section revision', async () => {
      const r = await POST(
        req({
          sectionId: INTRO_ID,
          content: '# Intro\nrewritten by hand\n',
          expectedFingerprint: INTRO_FP,
        }),
        params(DOC_ID)
      );
      expect(r.status).toBe(200);

      // First arg = docId, second arg = new full doc content
      const callArgs = mockWriteCleanupContent.mock.calls[0];
      expect(callArgs[0]).toBe(DOC_ID);
      expect(callArgs[1]).toBe('# Intro\nrewritten by hand\n# Body\nsecond body');
      expect(callArgs[2]).toMatchObject({
        source: 'human_section',
        actorId: ADMIN_ID,
        sectionMarker: 'Intro',
      });
    });
  });
});
