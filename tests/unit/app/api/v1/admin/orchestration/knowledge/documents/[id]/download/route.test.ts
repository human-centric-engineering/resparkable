/**
 * Unit Tests: GET /knowledge/documents/[id]/download
 *
 * Returns a document's text as a Markdown attachment. Which text exists
 * depends on lifecycle stage — a finished document has had both content
 * columns cleared, so its download is rebuilt from chunks.
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/download/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFindUnique, mockRebuild } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockRebuild: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiKnowledgeDocument: { findUnique: mockFindUnique } },
}));

vi.mock('@/lib/orchestration/knowledge/document-text', () => ({
  rebuildTextFromChunks: mockRebuild,
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/download/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';

function req(docId: string, query = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${docId}/download${query}`
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'ConQuest Go to Market Plan',
    fileName: 'plan.pdf',
    slug: 'conquest-go-to-market-plan-ab12cd34',
    status: 'cleaning',
    originalContent: 'raw parsed text',
    processedContent: 'cleaned text',
    metadata: null,
    ...overrides,
  };
}

describe('GET /knowledge/documents/[id]/download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockFindUnique.mockResolvedValue(makeDoc());
    mockRebuild.mockResolvedValue({ text: 'chunk one\n\nchunk two', chunkCount: 2 });
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      expect((await GET(req(DOC_ID), params(DOC_ID))).status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      expect((await GET(req(DOC_ID), params(DOC_ID))).status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid document CUID', async () => {
      expect((await GET(req(INVALID_ID), params(INVALID_ID))).status).toBe(400);
    });

    it('400 on an unrecognised variant', async () => {
      const res = await GET(req(DOC_ID, '?variant=pdf'), params(DOC_ID));
      expect(res.status).toBe(400);
    });

    it('404 when the document does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);
      const res = await GET(req(DOC_ID), params(DOC_ID));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('variant selection', () => {
    it('serves the cleaned text by default while a cleanup is in progress', async () => {
      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('cleaned text');
      expect(res.headers.get('X-Document-Variant')).toBe('cleaned');
      expect(mockRebuild).not.toHaveBeenCalled();
    });

    it('serves the original when explicitly asked, even mid-cleanup', async () => {
      const res = await GET(req(DOC_ID, '?variant=original'), params(DOC_ID));

      expect(await res.text()).toBe('raw parsed text');
      expect(res.headers.get('X-Document-Variant')).toBe('original');
    });

    it('falls back to the original when no cleanup has written anything yet', async () => {
      mockFindUnique.mockResolvedValue(makeDoc({ processedContent: null }));

      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(await res.text()).toBe('raw parsed text');
      expect(res.headers.get('X-Document-Variant')).toBe('original');
    });

    it('rebuilds from chunks for a finished document, whose content columns are cleared', async () => {
      mockFindUnique.mockResolvedValue(
        makeDoc({ status: 'ready', originalContent: null, processedContent: null })
      );

      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(mockRebuild).toHaveBeenCalledWith(DOC_ID);
      expect(await res.text()).toBe('chunk one\n\nchunk two');
      expect(res.headers.get('X-Document-Variant')).toBe('chunks');
    });

    it('serves the extracted PDF text for a document still awaiting confirmation', async () => {
      // pending_review documents keep the extracted text on metadata until
      // the admin confirms — originalContent is still null.
      mockFindUnique.mockResolvedValue(
        makeDoc({
          status: 'pending_review',
          originalContent: null,
          processedContent: null,
          metadata: { extractedText: 'text pulled out of the PDF' },
        })
      );

      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(await res.text()).toBe('text pulled out of the PDF');
      expect(res.headers.get('X-Document-Variant')).toBe('original');
    });

    it('rebuilds from chunks when explicitly asked, even though content exists', async () => {
      const res = await GET(req(DOC_ID, '?variant=chunks'), params(DOC_ID));

      expect(await res.text()).toBe('chunk one\n\nchunk two');
    });

    it('404s with the variant and status when the requested form has no text', async () => {
      mockFindUnique.mockResolvedValue(
        makeDoc({ status: 'failed', originalContent: null, processedContent: null })
      );
      mockRebuild.mockResolvedValue({ text: '', chunkCount: 0 });

      const res = await GET(req(DOC_ID), params(DOC_ID));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error.code).toBe('NO_TEXT_AVAILABLE');
      // Variant + status together are what explain the emptiness.
      expect(body.error.details.variant).toEqual(['chunks']);
      expect(body.error.details.status).toEqual(['failed']);
    });
  });

  describe('attachment headers', () => {
    it('sends Markdown as a download named after the slug', async () => {
      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('Content-Disposition')).toBe(
        'attachment; filename="conquest-go-to-market-plan-ab12cd34.md"'
      );
      // The slug is filename-safe; the display name is not.
      expect(res.headers.get('Content-Disposition')).not.toContain('ConQuest Go to Market');
    });

    it('marks an original download so it does not overwrite the cleaned one', async () => {
      const res = await GET(req(DOC_ID, '?variant=original'), params(DOC_ID));

      expect(res.headers.get('Content-Disposition')).toContain('-original.md');
    });

    it('is never cached — the text changes on every cleanup step', async () => {
      const res = await GET(req(DOC_ID), params(DOC_ID));

      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });
});
