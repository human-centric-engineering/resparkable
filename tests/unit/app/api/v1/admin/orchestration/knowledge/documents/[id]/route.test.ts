import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
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
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';

function req(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}`,
    { method: 'GET' }
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

// Focused regression test for the Phase 7 contract change: the GET handler
// now `include`s a pendingChanges relation so the cleanup PendingChangeModal
// can render the diff card with a single round-trip. The rest of the route's
// behaviour (PATCH/DELETE, tag flattening) is covered by other suites; this
// file pins the new include + the GET response shape.

describe('GET /api/v1/admin/orchestration/knowledge/documents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth + validation', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await GET(req(), params(DOC_ID));
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await GET(req(), params(DOC_ID));
      expect(r.status).toBe(403);
    });

    it('400 on invalid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const r = await GET(req(), params('not-a-cuid'));
      expect(r.status).toBe(400);
    });

    it('404 when document does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockFindUnique.mockResolvedValue(null);
      const r = await GET(req(), params(DOC_ID));
      expect(r.status).toBe(404);
    });
  });

  describe('pendingChanges are NOT included', () => {
    it('does not include pendingChanges — each row carries a full before + after copy of the document', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockFindUnique.mockResolvedValue({ id: DOC_ID, name: 'doc', tags: [] });
      await GET(req(), params(DOC_ID));

      // The cleanup view re-fetches this route after every chat turn,
      // capability result, section save and restore. Including the proposals
      // would put two extra copies of the document text on each of those
      // responses; the diff modal reads the single row it needs from
      // GET .../cleanup/changes/:changeId instead.
      const callArg = mockFindUnique.mock.calls[0][0] as { include: Record<string, unknown> };
      expect(callArg.include).not.toHaveProperty('pendingChanges');
    });
  });

  describe('tag flattening (existing behaviour, regression guard)', () => {
    it('flattens the tag join rows into a tagIds string array', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockFindUnique.mockResolvedValue({
        id: DOC_ID,
        name: 'doc',
        tags: [{ tagId: 'tag-1' }, { tagId: 'tag-2' }],
        pendingChanges: [],
      });
      const r = await GET(req(), params(DOC_ID));
      const body = await r.json();
      expect(body.data.document.tagIds).toEqual(['tag-1', 'tag-2']);
      // The raw `tags` join rows are removed from the response.
      expect(body.data.document.tags).toBeUndefined();
    });
  });
});
