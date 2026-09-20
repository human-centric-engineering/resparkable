/**
 * Unit Tests: GET /cleanup/revisions/[version]
 *
 * Returns one revision's full content plus its predecessor's, so the history
 * view can show what a given step changed without a second round trip. The
 * list endpoint deliberately omits content (every row holds the whole
 * document), which is why this route exists at all.
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/[version]/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFindUnique, mockFindFirst } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
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
    aiKnowledgeDocumentRevision: {
      findUnique: mockFindUnique,
      findFirst: mockFindFirst,
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/[version]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';

function req(docId: string, version: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${docId}/cleanup/revisions/${version}`
  );
}

function params(id: string, version: string) {
  return { params: Promise.resolve({ id, version }) };
}

function makeRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-5',
    documentId: DOC_ID,
    version: 5,
    content: 'content at v5',
    source: 'capability:dedupe_lines',
    actorId: 'admin-1',
    sectionMarker: null,
    instructions: null,
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

async function body(res: Response): Promise<{ success: boolean; data?: Record<string, unknown> }> {
  return (await res.json()) as { success: boolean; data?: Record<string, unknown> };
}

describe('GET /cleanup/revisions/[version]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockFindUnique.mockResolvedValue(makeRevision());
    mockFindFirst.mockResolvedValue({ version: 4, content: 'content at v4' });
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      expect((await GET(req(DOC_ID, '5'), params(DOC_ID, '5'))).status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      expect((await GET(req(DOC_ID, '5'), params(DOC_ID, '5'))).status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid document CUID', async () => {
      expect((await GET(req(INVALID_ID, '5'), params(INVALID_ID, '5'))).status).toBe(400);
    });

    it('400 when the version is not a positive integer', async () => {
      expect((await GET(req(DOC_ID, 'abc'), params(DOC_ID, 'abc'))).status).toBe(400);
      expect((await GET(req(DOC_ID, '0'), params(DOC_ID, '0'))).status).toBe(400);
    });

    it('404 when the revision does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);
      const res = await GET(req(DOC_ID, '5'), params(DOC_ID, '5'));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('REVISION_NOT_FOUND');
    });
  });

  describe('payload', () => {
    it('returns the revision content and its predecessor', async () => {
      const res = await GET(req(DOC_ID, '5'), params(DOC_ID, '5'));
      const payload = await body(res);

      expect(res.status).toBe(200);
      expect(payload.data?.revision).toMatchObject({ version: 5, content: 'content at v5' });
      expect(payload.data?.previous).toMatchObject({ version: 4, content: 'content at v4' });
      expect(payload.data?.previousPruned).toBe(false);
    });

    it('looks up the predecessor by highest version below this one, not version - 1', async () => {
      // Retention pruning leaves gaps, so `version - 1` may not exist. The
      // diff has to be against the nearest surviving ancestor.
      await GET(req(DOC_ID, '5'), params(DOC_ID, '5'));

      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { documentId: DOC_ID, version: { lt: 5 } },
          orderBy: { version: 'desc' },
        })
      );
    });

    it('reports previousPruned when an older revision has no surviving predecessor', async () => {
      mockFindFirst.mockResolvedValue(null);
      const payload = await body(await GET(req(DOC_ID, '5'), params(DOC_ID, '5')));

      expect(payload.data?.previous).toBeNull();
      // v5 with nothing before it means the earlier rows were pruned — the UI
      // must not imply the document started here.
      expect(payload.data?.previousPruned).toBe(true);
    });

    it('does not report pruning for version 1, which legitimately has no predecessor', async () => {
      mockFindUnique.mockResolvedValue(makeRevision({ version: 1 }));
      mockFindFirst.mockResolvedValue(null);
      const payload = await body(await GET(req(DOC_ID, '1'), params(DOC_ID, '1')));

      expect(payload.data?.previousPruned).toBe(false);
    });
  });
});
