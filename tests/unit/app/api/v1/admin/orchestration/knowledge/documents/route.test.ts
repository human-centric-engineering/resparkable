// @vitest-environment happy-dom

/**
 * Unit Tests: Knowledge Document List + Upload Endpoints
 *
 * GET  /api/v1/admin/orchestration/knowledge/documents
 * POST /api/v1/admin/orchestration/knowledge/documents
 *
 * Test Coverage:
 * - GET: pagination, status filter, scope filter, category filter, q filter
 * - GET: authentication, rate limiting (GET has no rate limit — only POST does)
 * - POST: text upload (md/txt), binary upload (epub/docx), PDF preview path
 * - POST: validation errors — no file, file too large, unsupported extension
 * - POST: line count and line length guards for text files
 * - POST: category field from form data
 * - POST: rate limiting and authentication
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    aiKnowledgeDocumentTag: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Distinct keyword count aggregation; defaults to none for existing tests.
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/knowledge/document-manager', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/knowledge/document-manager')>();
  return {
    ...real,
    uploadDocument: vi.fn(),
    uploadDocumentFromBuffer: vi.fn(),
    previewDocument: vi.fn(),
    createDocumentForCleanup: vi.fn(),
    parseDocumentMetadata: vi.fn(() => ({})),
  };
});

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  requiresPreview: vi.fn(() => false),
  parseDocument: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/admin/orchestration/knowledge/documents/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
  createDocumentForCleanup,
  parseDocumentMetadata,
} from '@/lib/orchestration/knowledge/document-manager';
import { requiresPreview, parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeGetRequest(queryString = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents${queryString}`,
  } as unknown as NextRequest;
}

/**
 * Creates a mock FormData with a synthetic File object.
 */
function makeFileRequest(
  fileName: string,
  content: string | ArrayBuffer,
  mimeType = 'text/plain',
  extraFields: Record<string, string> = {}
): NextRequest {
  const blobContent: BlobPart = typeof content === 'string' ? content : content;
  const file = new File([blobContent], fileName, { type: mimeType });
  const formData = new FormData();
  formData.set('file', file);
  for (const [key, value] of Object.entries(extraFields)) {
    formData.set(key, value);
  }

  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'multipart/form-data' }),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
    formData: async () => formData,
  } as unknown as NextRequest;
}

function makeInvalidFormRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/documents',
    formData: async () => {
      throw new Error('Invalid multipart body');
    },
  } as unknown as NextRequest;
}

const mockDocument = {
  id: 'doc-001',
  name: 'Test Doc',
  fileName: 'test.md',
  status: 'ready',
  scope: null,
  category: null,
  createdAt: new Date(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Knowledge Documents API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  // ── GET — List documents ────────────────────────────────────────────────

  describe('GET /knowledge/documents', () => {
    it('returns paginated documents', async () => {
      // Arrange — list endpoint now returns inline tag chips alongside the
      // chunk count, so the mock has to mirror the new include shape.
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
        { ...mockDocument, _count: { chunks: 5 }, tags: [] },
      ] as never);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(1);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].tags).toEqual([]);
      // Default $queryRaw mock returns no rows → distinctKeywordCount defaults to 0.
      expect(json.data[0].distinctKeywordCount).toBe(0);
      expect(json.meta.total).toBe(1);
    });

    it('returns the distinct BM25 keyword count from the aggregation query', async () => {
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
        { ...mockDocument, id: 'doc-1', _count: { chunks: 3 }, tags: [] },
        { ...mockDocument, id: 'doc-2', _count: { chunks: 0 }, tags: [] },
      ] as never);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(2);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { documentId: 'doc-1', count: BigInt(7) },
      ] as never);

      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      const doc1 = json.data.find((d: { id: string }) => d.id === 'doc-1');
      const doc2 = json.data.find((d: { id: string }) => d.id === 'doc-2');
      expect(doc1.distinctKeywordCount).toBe(7);
      // Docs missing from the aggregation row default to 0, not undefined.
      expect(doc2.distinctKeywordCount).toBe(0);
    });

    it('omits the cleanup Text columns and lock bookkeeping from the query', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
        { ...mockDocument, _count: { chunks: 0 }, tags: [] },
      ] as never);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(1);

      // Act
      await GET(makeGetRequest());

      // Assert: a page of cleaning documents would otherwise carry the full
      // original + processed text of each one. KnowledgeDocumentListItem
      // declares these absent — the query is what makes that true.
      const callArg = vi.mocked(prisma.aiKnowledgeDocument.findMany).mock.calls[0][0] as {
        omit: Record<string, boolean>;
      };
      expect(callArg.omit).toEqual({
        originalContent: true,
        processedContent: true,
        editLockHolder: true,
        editLockAcquiredAt: true,
      });
    });

    it('filters by status', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?status=ready'));

      // Assert: where clause includes status
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ready' }),
        })
      );
    });

    it('filters by scope', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act: 'app' is a valid scope value (enum: 'system' | 'app')
      await GET(makeGetRequest('?scope=app'));

      // Assert: where clause includes scope
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scope: 'app' }),
        })
      );
    });

    it('applies text search (q param) using OR on name and fileName', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?q=pricing'));

      // Assert: where clause includes OR search
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: 'pricing', mode: 'insensitive' } }),
            ]),
          }),
        })
      );
    });

    it('applies pagination (page + limit)', async () => {
      // Arrange
      vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiKnowledgeDocument.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?page=2&limit=5'));

      // Assert: skip = (2-1)*5 = 5
      expect(prisma.aiKnowledgeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });

    it('rejects unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(401);
    });
  });

  // ── POST — Upload text document ─────────────────────────────────────────

  describe('POST /knowledge/documents — text files', () => {
    it('uploads a markdown document successfully', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({ ...mockDocument, id: 'doc-md-001' } as never);

      // Act
      const res = await POST(makeFileRequest('guide.md', '# Hello\nContent here', 'text/markdown'));
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-md-001');
      expect(uploadDocument).toHaveBeenCalledOnce();
    });

    it('uploads a txt document successfully', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({ ...mockDocument, id: 'doc-txt-001' } as never);

      // Act
      const res = await POST(makeFileRequest('notes.txt', 'Plain text content', 'text/plain'));
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-txt-001');
    });

    it('uploads passing only the standard fields (no category form field exists)', async () => {
      vi.mocked(uploadDocument).mockResolvedValue(mockDocument as never);

      await POST(makeFileRequest('guide.md', '# Hello', 'text/markdown'));

      // uploadDocument signature is (content, fileName, userId, sourceUrl, displayName).
      // The category form field was dropped in Phase 6; sourceUrl + displayName
      // are undefined for plain uploads from the admin form.
      expect(uploadDocument).toHaveBeenCalledWith(
        expect.any(String),
        'guide.md',
        ADMIN_ID,
        undefined,
        undefined
      );
    });

    it('returns 413 FILE_TOO_LARGE when file exceeds the maximum size (post-parse)', async () => {
      // The pre-parse `Content-Length` guard catches well-formed clients;
      // this exercises the post-parse path (chunked encoding or a lying
      // header). Both paths must return the same code + status so
      // client error mapping is uniform.
      const largeContent = 'x'.repeat(50 * 1024 * 1024 + 1);
      const file = new File([largeContent], 'huge.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.set('file', file);

      const req: NextRequest = {
        method: 'POST',
        headers: new Headers(),
        url: 'http://localhost:3000/test',
        formData: async () => formData,
      } as unknown as NextRequest;

      const res = await POST(req);

      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FILE_TOO_LARGE');
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_FILE_TYPE for unsupported file extension', async () => {
      const res = await POST(makeFileRequest('malware.exe', 'binary', 'application/octet-stream'));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_FILE_TYPE');
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 when the file field is missing', async () => {
      // Arrange: formData has no file
      const formData = new FormData();
      formData.set('category', 'test');
      const req: NextRequest = {
        method: 'POST',
        headers: new Headers(),
        url: 'http://localhost:3000/test',
        formData: async () => formData,
      } as unknown as NextRequest;

      // Act
      const res = await POST(req);

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 when the request body is not multipart/form-data', async () => {
      // Arrange: formData() throws
      const res = await POST(makeInvalidFormRequest());

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 when document has too many lines', async () => {
      // Arrange: 100,001 lines (exceeds MAX_LINE_COUNT of 100,000)
      const manyLines = Array(100_001).fill('line').join('\n');
      const res = await POST(makeFileRequest('big.md', manyLines));

      // Assert
      expect(res.status).toBe(400);
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 when document contains excessively long lines', async () => {
      // Arrange: one line that exceeds 10,000 chars
      const longLine = 'x'.repeat(10_001);
      const res = await POST(makeFileRequest('long-line.md', longLine));

      // Assert
      expect(res.status).toBe(400);
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });

  // ── POST — Upload binary document (EPUB, DOCX) ──────────────────────────

  describe('POST /knowledge/documents — binary files', () => {
    it('uploads an EPUB document via buffer path', async () => {
      // Arrange: requiresPreview returns false for EPUB
      vi.mocked(requiresPreview).mockReturnValue(false);
      vi.mocked(uploadDocumentFromBuffer).mockResolvedValue({
        ...mockDocument,
        id: 'doc-epub-001',
        fileName: 'book.epub',
      } as never);

      // Act
      const res = await POST(
        makeFileRequest('book.epub', new Uint8Array([0, 1, 2, 3]).buffer, 'application/epub+zip')
      );
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-epub-001');
      expect(uploadDocumentFromBuffer).toHaveBeenCalledOnce();
    });

    it('creates a preview for PDF documents', async () => {
      // Arrange: requiresPreview returns true for PDF
      vi.mocked(requiresPreview).mockReturnValue(true);
      vi.mocked(previewDocument).mockResolvedValue({
        document: { ...mockDocument, id: 'doc-pdf-001', fileName: 'report.pdf' },
        extractedText: 'PDF content here',
        title: 'Annual Report',
        author: 'Acme Corp',
        sectionCount: 5,
        warnings: [],
      } as never);

      // Act
      const res = await POST(
        makeFileRequest('report.pdf', new Uint8Array([0, 1, 2, 3]).buffer, 'application/pdf')
      );
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-pdf-001');
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(json.data.preview.requiresConfirmation).toBe(true);
      expect(json.data.preview.title).toBe('Annual Report');
      expect(previewDocument).toHaveBeenCalledOnce();
      expect(uploadDocumentFromBuffer).not.toHaveBeenCalled();
    });

    it('serialises missing PDF author as null, not undefined', async () => {
      // Regression: `DocumentPreview.author` is `string | undefined`. JSON
      // serialises `undefined` as the key being absent, but the client's
      // Zod schema declares author `.nullable()` (string | null) and
      // rejects undefined with "Invalid input: expected string, received
      // undefined". The route must coerce undefined → null so the wire
      // format matches the schema's contract.
      vi.mocked(requiresPreview).mockReturnValue(true);
      vi.mocked(previewDocument).mockResolvedValue({
        document: { ...mockDocument, id: 'doc-pdf-002', fileName: 'no-author.pdf' },
        extractedText: 'PDF without author metadata',
        title: 'Untitled',
        // author intentionally omitted — PDF has no Author key.
        sectionCount: 1,
        warnings: [],
      } as never);

      const res = await POST(
        makeFileRequest('no-author.pdf', new Uint8Array([0, 1, 2]).buffer, 'application/pdf')
      );
      const json = JSON.parse(await res.text()) as {
        data: { preview: { author: unknown } };
      };

      expect(res.status).toBe(201);
      // The presence-and-null assertion is the contract: the key must
      // appear in the JSON envelope and its value must be null. A bare
      // `toBeNull()` would also pass if the key was absent, which would
      // re-introduce the bug.
      expect(Object.prototype.hasOwnProperty.call(json.data.preview, 'author')).toBe(true);
      expect(json.data.preview.author).toBeNull();
    });
  });

  // ── POST — runCleanup branches ──────────────────────────────────────────

  describe('POST /knowledge/documents — runCleanup=true (text)', () => {
    it('calls createDocumentForCleanup and returns 201 with { document, redirectTo } for text upload', async () => {
      // Arrange
      const cleanupDoc = { id: 'doc-cleanup-001', name: 'My Guide', fileName: 'guide.txt' };
      const redirectTo = '/admin/orchestration/knowledge/doc-cleanup-001/cleanup';
      vi.mocked(createDocumentForCleanup).mockResolvedValue({
        document: cleanupDoc as never,
        conversationId: 'conv-001',
        redirectTo,
      });

      // Act
      const res = await POST(
        makeFileRequest('guide.txt', 'Some text content', 'text/plain', { runCleanup: 'true' })
      );
      const json = JSON.parse(await res.text()) as {
        success: boolean;
        data: { document: { id: string }; redirectTo: string };
      };

      // Assert — route calls the cleanup helper, not uploadDocument, and wraps result in envelope
      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.document.id).toBe('doc-cleanup-001');
      expect(json.data.redirectTo).toBe(redirectTo);
      expect(createDocumentForCleanup).toHaveBeenCalledOnce();
      expect(uploadDocument).not.toHaveBeenCalled();
    });

    it('returns 400 for text upload with runCleanup=true AND a line that exceeds max length', async () => {
      // Arrange: a line longer than MAX_LINE_LENGTH (10,000 chars) — validation fires BEFORE cleanup helper
      const longLine = 'x'.repeat(10_001);

      // Act
      const res = await POST(
        makeFileRequest('guide.txt', longLine, 'text/plain', { runCleanup: 'true' })
      );

      // Assert — validation error; cleanup helper never reached
      expect(res.status).toBe(400);
      expect(createDocumentForCleanup).not.toHaveBeenCalled();
    });

    it('calls uploadDocument (not createDocumentForCleanup) when runCleanup is absent', async () => {
      // Arrange
      vi.mocked(uploadDocument).mockResolvedValue({
        ...mockDocument,
        id: 'doc-normal-001',
      } as never);

      // Act
      const res = await POST(makeFileRequest('guide.txt', 'Some content', 'text/plain'));
      const json = JSON.parse(await res.text()) as {
        success: boolean;
        data: { document: { id: string } };
      };

      // Assert — regression guard: no cleanup involved
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-normal-001');
      expect(uploadDocument).toHaveBeenCalledOnce();
      expect(createDocumentForCleanup).not.toHaveBeenCalled();
    });
  });

  describe('POST /knowledge/documents — runCleanup=true (PDF)', () => {
    it('writes metadata.runCleanup=true to the preview doc before returning the preview payload', async () => {
      // Arrange
      vi.mocked(requiresPreview).mockReturnValue(true);
      vi.mocked(previewDocument).mockResolvedValue({
        document: {
          ...mockDocument,
          id: 'doc-pdf-cleanup-001',
          fileName: 'report.pdf',
          metadata: {},
        },
        extractedText: 'PDF text',
        title: 'Report',
        author: null,
        sectionCount: 2,
        warnings: [],
      } as never);
      vi.mocked(parseDocumentMetadata).mockReturnValue({});
      vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue({} as never);

      // Act
      const res = await POST(
        makeFileRequest('report.pdf', new Uint8Array([0, 1, 2]).buffer, 'application/pdf', {
          runCleanup: 'true',
        })
      );

      // Assert — update was called with runCleanup: true in the metadata before the preview payload is returned
      expect(res.status).toBe(201);
      expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-pdf-cleanup-001' },
          data: expect.objectContaining({
            metadata: expect.objectContaining({ runCleanup: true }),
          }),
        })
      );
    });
  });

  describe('POST /knowledge/documents — runCleanup=true (binary: EPUB/DOCX)', () => {
    it('parses EPUB to text then calls createDocumentForCleanup', async () => {
      // Arrange: EPUB (not PDF, so requiresPreview=false) with runCleanup=true
      vi.mocked(requiresPreview).mockReturnValue(false);
      vi.mocked(parseDocument).mockResolvedValue({
        fullText: 'EPUB full text',
        title: 'My Book',
        sections: [],
        metadata: { format: 'epub' },
        warnings: [],
      });
      const cleanupDoc = { id: 'doc-epub-cleanup-001', name: 'My Book', fileName: 'book.epub' };
      vi.mocked(createDocumentForCleanup).mockResolvedValue({
        document: cleanupDoc as never,
        conversationId: 'conv-epub-001',
        redirectTo: '/admin/orchestration/knowledge/doc-epub-cleanup-001/cleanup',
      });

      // Act
      const res = await POST(
        makeFileRequest('book.epub', new Uint8Array([0, 1, 2]).buffer, 'application/epub+zip', {
          runCleanup: 'true',
        })
      );
      const json = JSON.parse(await res.text()) as {
        success: boolean;
        data: { document: { id: string }; redirectTo: string };
      };

      // Assert — route parses the binary, then routes to cleanup instead of chunking
      expect(res.status).toBe(201);
      expect(json.data.document.id).toBe('doc-epub-cleanup-001');
      expect(json.data.redirectTo).toContain('/cleanup');
      expect(createDocumentForCleanup).toHaveBeenCalledOnce();
      expect(uploadDocumentFromBuffer).not.toHaveBeenCalled();
    });
  });

  describe('POST /knowledge/documents — runCleanup=true (CSV)', () => {
    it('returns 400 with CLEANUP_UNSUPPORTED_FORMAT for CSV files with runCleanup=true', async () => {
      // Arrange: CSV file (not PDF so requiresPreview=false), runCleanup=true
      vi.mocked(requiresPreview).mockReturnValue(false);
      vi.mocked(parseDocument).mockResolvedValue({
        fullText: 'col1,col2\nval1,val2',
        title: 'data',
        sections: [],
        metadata: { format: 'csv' },
        warnings: [],
      });

      // Act
      const res = await POST(
        makeFileRequest('data.csv', new Uint8Array([0, 1, 2]).buffer, 'text/csv', {
          runCleanup: 'true',
        })
      );
      const json = JSON.parse(await res.text()) as { success: boolean; error: { code: string } };

      // Assert — route refuses cleanup for CSV format
      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('CLEANUP_UNSUPPORTED_FORMAT');
      expect(createDocumentForCleanup).not.toHaveBeenCalled();
    });
  });

  // ── POST — Rate limiting and auth ────────────────────────────────────────
});
