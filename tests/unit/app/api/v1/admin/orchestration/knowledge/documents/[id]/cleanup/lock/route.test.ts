import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockAcquireEditLock, mockReleaseEditLock, mockGetEditLockState, mockFindFirstDoc } =
  vi.hoisted(() => ({
    mockAcquireEditLock: vi.fn(),
    mockReleaseEditLock: vi.fn(),
    mockGetEditLockState: vi.fn(),
    mockFindFirstDoc: vi.fn(),
  }));

vi.mock('@/lib/orchestration/knowledge/edit-lock', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestration/knowledge/edit-lock')>(
    '@/lib/orchestration/knowledge/edit-lock'
  );
  return {
    ...actual,
    acquireEditLock: mockAcquireEditLock,
    releaseEditLock: mockReleaseEditLock,
    getEditLockState: mockGetEditLockState,
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: { findFirst: mockFindFirstDoc },
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

import { auth } from '@/lib/auth/config';
import {
  DELETE,
  GET,
  POST,
} from '@/app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/lock/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const DOC_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function req(method: 'GET' | 'POST' | 'DELETE'): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/knowledge/documents/${DOC_ID}/cleanup/lock`,
    { method }
  );
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('Cleanup edit-lock route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('auth boundary', () => {
    it.each(['GET', 'POST', 'DELETE'] as const)('%s — 401 when unauthenticated', async (verb) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const handler = verb === 'GET' ? GET : verb === 'POST' ? POST : DELETE;
      const response = await handler(req(verb), params(DOC_ID));
      expect(response.status).toBe(401);
    });

    it.each(['GET', 'POST', 'DELETE'] as const)('%s — 403 when non-admin', async (verb) => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const handler = verb === 'GET' ? GET : verb === 'POST' ? POST : DELETE;
      const response = await handler(req(verb), params(DOC_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('400 on invalid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await GET(req('GET'), params(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('GET', () => {
    it('returns lock state with ttlMs', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const now = new Date('2026-06-01T10:00:00Z');
      mockGetEditLockState.mockResolvedValue({
        heldBy: 'user-a',
        acquiredAt: now,
        active: true,
      });

      const response = await GET(req('GET'), params(DOC_ID));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.heldBy).toBe('user-a');
      expect(body.data.active).toBe(true);
      expect(body.data.ttlMs).toBe(5 * 60 * 1000);
    });
  });

  describe('POST', () => {
    beforeEach(() => {
      // Default: caller owns the doc and it's in cleaning status
      mockFindFirstDoc.mockResolvedValue({ id: DOC_ID });
    });

    it('200 when lock acquired', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const acquiredAt = new Date('2026-06-01T10:00:00Z');
      mockAcquireEditLock.mockResolvedValue({ acquired: true, acquiredAt });

      const response = await POST(req('POST'), params(DOC_ID));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.acquired).toBe(true);
      expect(body.data.ttlMs).toBe(5 * 60 * 1000);
    });

    it('423 LOCK_HELD when another admin owns the lock', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockAcquireEditLock.mockResolvedValue({ acquired: false, heldBy: 'other-admin' });

      const response = await POST(req('POST'), params(DOC_ID));
      expect(response.status).toBe(423);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('LOCK_HELD');
      expect(body.error.details.heldBy).toEqual(['other-admin']);
    });

    it('400 when the caller does not own the document (or it is not in cleaning status)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      mockFindFirstDoc.mockResolvedValue(null);

      const response = await POST(req('POST'), params(DOC_ID));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      // Ownership must be checked before acquiring — a non-owner can't grab
      // (or perpetually renew) the lock on someone else's document.
      expect(mockAcquireEditLock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('200 on release (idempotent)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(req('DELETE'), params(DOC_ID));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.released).toBe(true);
      expect(mockReleaseEditLock).toHaveBeenCalledWith(DOC_ID, expect.any(String));
    });
  });
});
