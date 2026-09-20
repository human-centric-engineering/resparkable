/**
 * GET /cleanup/changes/:changeId — read one pending LLM-rewrite proposal
 *
 * Test Coverage:
 * - auth boundary (401 unauthenticated, 403 non-admin)
 * - CUID validation on both path params
 * - scoping: the lookup is by (changeId, documentId), so a change belonging
 *   to another document is not readable through this document's URL
 * - projection: only the fields the diff modal renders come back
 * - 404 CHANGE_NOT_FOUND once the row has been accepted or rejected
 *
 * @see app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFindFirstChange } = vi.hoisted(() => ({
  mockFindFirstChange: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocumentPendingChange: { findFirst: mockFindFirstChange },
  },
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const CHANGE_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

const mockChange = {
  id: CHANGE_ID,
  source: 'rewrite_section_with_llm',
  beforeContent: '# A\nold',
  afterContent: '# A\nnew',
  sectionMarker: '# A',
  instructions: 'tighten',
  createdAt: new Date('2026-06-01T00:00:00Z'),
};

function req(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/changes/${CHANGE_ID}`
  );
}

function params(id: string, changeId: string) {
  return { params: Promise.resolve({ id, changeId }) };
}

describe('GET /cleanup/changes/:changeId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockFindFirstChange.mockResolvedValue(mockChange);
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await GET(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(401);
      expect(mockFindFirstChange).not.toHaveBeenCalled();
    });

    it('403 when authenticated but not an admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const r = await GET(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(403);
      expect(mockFindFirstChange).not.toHaveBeenCalled();
    });
  });

  describe('path param validation', () => {
    it('rejects a non-CUID document id', async () => {
      const r = await GET(req(), params(INVALID_ID, CHANGE_ID));
      expect(r.status).toBe(400);
      expect(mockFindFirstChange).not.toHaveBeenCalled();
    });

    it('rejects a non-CUID change id', async () => {
      const r = await GET(req(), params(DOC_ID, INVALID_ID));
      expect(r.status).toBe(400);
      expect(mockFindFirstChange).not.toHaveBeenCalled();
    });
  });

  describe('lookup', () => {
    it('scopes the lookup to the document in the URL', async () => {
      await GET(req(), params(DOC_ID, CHANGE_ID));
      // Scoping by documentId is what stops a change id from one document
      // being read through another document's URL.
      expect(mockFindFirstChange).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CHANGE_ID, documentId: DOC_ID } })
      );
    });

    it('selects only the fields the diff modal renders', async () => {
      await GET(req(), params(DOC_ID, CHANGE_ID));
      const callArg = mockFindFirstChange.mock.calls[0][0] as { select: Record<string, boolean> };
      expect(callArg.select).toEqual({
        id: true,
        source: true,
        beforeContent: true,
        afterContent: true,
        sectionMarker: true,
        instructions: true,
        createdAt: true,
      });
      // actorId is deliberately absent — the modal has no use for it.
      expect(callArg.select).not.toHaveProperty('actorId');
    });

    it('returns the change under data.change', async () => {
      const r = await GET(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      expect(body.data.change.id).toBe(CHANGE_ID);
      expect(body.data.change.beforeContent).toBe('# A\nold');
      expect(body.data.change.afterContent).toBe('# A\nnew');
    });

    it('404 CHANGE_NOT_FOUND once the row has been accepted or rejected', async () => {
      // Accept and Reject hard-delete the row — there is no status column.
      mockFindFirstChange.mockResolvedValue(null);
      const r = await GET(req(), params(DOC_ID, CHANGE_ID));
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body.error.code).toBe('CHANGE_NOT_FOUND');
    });
  });
});
