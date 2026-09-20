import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocumentRevision: {
      findMany: mockFindMany,
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { GET } from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// DOC_ID must differ from ADMIN_ID (which is the hardcoded session user id).
const DOC_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';

function req(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function docUrl(id: string, search = ''): string {
  return `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${id}/cleanup/revisions${search}`;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /cleanup/revisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockFindMany.mockResolvedValue([]);
  });

  describe('auth boundary', () => {
    it('401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const r = await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(r.status).toBe(401);
    });

    it('403 when non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const r = await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(r.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid CUID', async () => {
      const r = await GET(req(docUrl(INVALID_ID)), params(INVALID_ID));
      expect(r.status).toBe(400);
    });

    it('400 when limit is below 1', async () => {
      const r = await GET(req(docUrl(DOC_ID, '?limit=0')), params(DOC_ID));
      expect(r.status).toBe(400);
    });

    it('400 when limit is above 200', async () => {
      const r = await GET(req(docUrl(DOC_ID, '?limit=201')), params(DOC_ID));
      expect(r.status).toBe(400);
    });
  });

  describe('limit handling', () => {
    it('queries with default limit of 50 when limit param is omitted', async () => {
      await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    });

    it('queries with a custom limit when provided', async () => {
      await GET(req(docUrl(DOC_ID, '?limit=10')), params(DOC_ID));
      expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
    });
  });

  describe('charsDelta computation', () => {
    it('computes charsDelta of each revision against its immediately-prior version (index N+1)', async () => {
      // 3 revisions returned newest-first:
      //   index 0: v3 content length=100
      //   index 1: v2 content length=80
      //   index 2: v1 content length=60
      // Expected deltas:
      //   v3: 100 - 80 = +20  (prior is index 1)
      //   v2: 80  - 60 = +20  (prior is index 2)
      //   v1: 60         (no prior — equals full contentLength)
      const now = new Date('2026-06-01T10:00:00Z');
      mockFindMany.mockResolvedValue([
        {
          id: 'rev3',
          version: 3,
          source: 'human_full',
          actorId: 'admin-1',
          sectionMarker: null,
          instructions: null,
          createdAt: now,
          content: 'A'.repeat(100),
        },
        {
          id: 'rev2',
          version: 2,
          source: 'human_section',
          actorId: 'admin-1',
          sectionMarker: 'Intro',
          instructions: null,
          createdAt: now,
          content: 'A'.repeat(80),
        },
        {
          id: 'rev1',
          version: 1,
          source: 'capability:cleanup',
          actorId: 'system',
          sectionMarker: null,
          instructions: 'Initial cleanup',
          createdAt: now,
          content: 'A'.repeat(60),
        },
      ]);

      const r = await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(r.status).toBe(200);
      const body = await r.json();
      const revisions: Array<{
        id: string;
        contentLength: number;
        charsDelta: number;
      }> = body.data.revisions;

      // v3 (index 0): delta = 100 - 80 = 20
      expect(revisions[0]).toMatchObject({ id: 'rev3', contentLength: 100, charsDelta: 20 });
      // v2 (index 1): delta = 80 - 60 = 20
      expect(revisions[1]).toMatchObject({ id: 'rev2', contentLength: 80, charsDelta: 20 });
      // v1 (index 2): no prior, delta = full contentLength = 60
      expect(revisions[2]).toMatchObject({ id: 'rev1', contentLength: 60, charsDelta: 60 });
    });

    it('newest revision charsDelta equals its full contentLength when it is the only revision', async () => {
      // When only one revision exists, there is no prior to compare against.
      // charsDelta must equal contentLength.
      const now = new Date('2026-06-01T10:00:00Z');
      mockFindMany.mockResolvedValue([
        {
          id: 'rev1',
          version: 1,
          source: 'capability:cleanup',
          actorId: 'system',
          sectionMarker: null,
          instructions: null,
          createdAt: now,
          content: 'A'.repeat(42),
        },
      ]);

      const r = await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(r.status).toBe(200);
      const body = await r.json();
      const [only]: Array<{ contentLength: number; charsDelta: number }> = body.data.revisions;
      // charsDelta = contentLength when there is no prior version
      expect(only.contentLength).toBe(42);
      expect(only.charsDelta).toBe(42);
    });
  });

  describe('response shape', () => {
    it('returns revisions newest-first with correct fields stripped of raw content', async () => {
      // The route must NOT expose raw `content` in the response — only
      // contentLength and charsDelta are surfaced so the drawer can summarise
      // without leaking the full text in the list payload.
      const now = new Date('2026-06-01T10:00:00Z');
      mockFindMany.mockResolvedValue([
        {
          id: 'rev2',
          version: 2,
          source: 'human_full',
          actorId: 'admin-1',
          sectionMarker: null,
          instructions: null,
          createdAt: now,
          content: 'A'.repeat(50),
        },
        {
          id: 'rev1',
          version: 1,
          source: 'capability:cleanup',
          actorId: 'system',
          sectionMarker: null,
          instructions: null,
          createdAt: now,
          content: 'A'.repeat(30),
        },
      ]);

      const r = await GET(req(docUrl(DOC_ID)), params(DOC_ID));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.success).toBe(true);
      // Raw content must not be present — the route strips it and exposes contentLength
      expect(body.data.revisions[0]).not.toHaveProperty('content');
      expect(body.data.revisions[0]).toMatchObject({
        id: 'rev2',
        version: 2,
        source: 'human_full',
        contentLength: 50,
      });
    });
  });
});
