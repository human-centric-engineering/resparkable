import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindUnique, mockUpdate, mockUpdateMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeDocument: {
      findUnique: mockFindUnique,
      update: mockUpdate,
      updateMany: mockUpdateMany,
    },
  },
}));

import {
  LOCK_TTL_MS,
  acquireEditLock,
  getEditLockState,
  releaseEditLock,
  requireEditableTarget,
} from '@/lib/orchestration/knowledge/edit-lock';

const DOC_ID = 'doc-lock-001';
const USER_A = 'user-a';
const USER_B = 'user-b';

describe('edit-lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getEditLockState', () => {
    it('returns inactive when no row exists', async () => {
      mockFindUnique.mockResolvedValue(null);
      const state = await getEditLockState(DOC_ID);
      expect(state).toEqual({ heldBy: null, acquiredAt: null, active: false });
    });

    it('returns inactive when lock columns are null', async () => {
      mockFindUnique.mockResolvedValue({ editLockHolder: null, editLockAcquiredAt: null });
      const state = await getEditLockState(DOC_ID);
      expect(state.active).toBe(false);
    });

    it('returns active when held within TTL', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:59:00Z'),
      });
      const state = await getEditLockState(DOC_ID);
      expect(state.active).toBe(true);
      expect(state.heldBy).toBe(USER_A);
    });

    it('returns inactive when held but TTL has expired', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:50:00Z'), // 10 min ago > 5 min TTL
      });
      const state = await getEditLockState(DOC_ID);
      expect(state.active).toBe(false);
      expect(state.heldBy).toBe(USER_A);
    });
  });

  describe('acquireEditLock', () => {
    // acquireEditLock is a single conditional updateMany (no read-then-write),
    // so it's atomic under concurrent callers — see edit-lock.ts. Tests drive
    // it purely through updateMany's result, not a prior findUnique read.

    it('acquires when free', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      const result = await acquireEditLock(DOC_ID, USER_A);
      expect(result.acquired).toBe(true);
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: DOC_ID,
          OR: [
            { editLockHolder: null },
            { editLockHolder: USER_A },
            { editLockAcquiredAt: { lt: expect.any(Date) } },
            { editLockAcquiredAt: null },
          ],
        },
        data: { editLockHolder: USER_A, editLockAcquiredAt: expect.any(Date) },
      });
    });

    it('refreshes when held by the same user', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      const result = await acquireEditLock(DOC_ID, USER_A);
      expect(result.acquired).toBe(true);
      expect(mockUpdateMany).toHaveBeenCalled();
    });

    it('refuses when held by a different user within TTL', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });
      // acquireEditLock re-reads state to report who holds it after a failed acquire.
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:59:00Z'),
      });
      const result = await acquireEditLock(DOC_ID, USER_B);
      expect(result.acquired).toBe(false);
      expect(result.heldBy).toBe(USER_A);
    });

    it('takes over when held by a different user but TTL has expired', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      const result = await acquireEditLock(DOC_ID, USER_B);
      expect(result.acquired).toBe(true);
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: DOC_ID,
          OR: [
            { editLockHolder: null },
            { editLockHolder: USER_B },
            { editLockAcquiredAt: { lt: expect.any(Date) } },
            { editLockAcquiredAt: null },
          ],
        },
        data: { editLockHolder: USER_B, editLockAcquiredAt: expect.any(Date) },
      });
    });
  });

  describe('releaseEditLock', () => {
    it('clears only when held by the caller (idempotent on no-op)', async () => {
      await releaseEditLock(DOC_ID, USER_A);
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: DOC_ID, editLockHolder: USER_A },
        data: { editLockHolder: null, editLockAcquiredAt: null },
      });
    });
  });

  describe('requireEditableTarget', () => {
    it('returns ok when no lock', async () => {
      mockFindUnique.mockResolvedValue({ editLockHolder: null, editLockAcquiredAt: null });
      const result = await requireEditableTarget(DOC_ID, USER_A);
      expect(result.ok).toBe(true);
    });

    it('returns ok when held by the calling user', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:59:00Z'),
      });
      const result = await requireEditableTarget(DOC_ID, USER_A);
      expect(result.ok).toBe(true);
    });

    it('returns ok when lock is expired, regardless of holder', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:50:00Z'),
      });
      const result = await requireEditableTarget(DOC_ID, USER_B);
      expect(result.ok).toBe(true);
    });

    it('refuses when held by a different user within TTL', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:59:00Z'),
      });
      const result = await requireEditableTarget(DOC_ID, USER_B);
      expect(result.ok).toBe(false);
      expect(result.heldBy).toBe(USER_A);
    });

    it('handles null userId correctly (treats as different from any holder)', async () => {
      mockFindUnique.mockResolvedValue({
        editLockHolder: USER_A,
        editLockAcquiredAt: new Date('2026-06-01T09:59:00Z'),
      });
      const result = await requireEditableTarget(DOC_ID, null);
      expect(result.ok).toBe(false);
    });
  });

  it('exports LOCK_TTL_MS at 5 minutes', () => {
    expect(LOCK_TTL_MS).toBe(5 * 60 * 1000);
  });
});
