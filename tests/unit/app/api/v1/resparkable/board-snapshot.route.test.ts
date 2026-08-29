/**
 * Unit Tests: `POST /api/v1/resparkable/boards/[id]/snapshot` (Release 2, phase 13).
 *
 * The route is thin — one call to `snapshotBoard`, one 404 branch, one log
 * line — so the tests are about the two things a thin handler can still get
 * wrong: returning the RE-READ view (not a patched-in-memory one) on success,
 * and treating "not this owner's board" and "already explicit" as the same
 * 404 rather than distinguishing them.
 *
 * @see app/api/v1/resparkable/boards/[id]/snapshot/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const routeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/api/context', () => ({ getRouteLogger: async () => routeLog }));

vi.mock('@/lib/logging', () => ({
  logger: {
    withContext: () => routeLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/framework/resparkable/services/board-view', () => ({
  snapshotBoard: vi.fn(),
}));

import { POST as SNAPSHOT_POST } from '@/app/api/v1/resparkable/boards/[id]/snapshot/route';
import { snapshotBoard } from '@/lib/framework/resparkable/services/board-view';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const VIEW = {
  board: {
    id: 'board_1',
    userId: 'user_a',
    createdByUserId: null,
    name: 'Sprint 12',
    slug: 'sprint-12',
    description: null,
    columns: [],
    membership: 'explicit',
    filter: null,
    swimlaneBy: null,
    visibility: 'private',
    archivedAt: null,
    archivedReason: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-28T10:00:00Z'),
  },
  columns: [],
  unplaced: [],
  totalCards: 3,
  filterSummary: null,
};

function req() {
  return {
    url: 'http://localhost/api/v1/resparkable/boards/board_1/snapshot',
    headers: new Headers(),
  } as unknown as Request;
}

function invoke(id: string): Promise<Response> {
  return (SNAPSHOT_POST as (...args: unknown[]) => Promise<Response>)(req(), SESSION, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/resparkable/boards/[id]/snapshot', () => {
  it('404s when snapshotBoard returns null — not this owner’s board, or already explicit', async () => {
    vi.mocked(snapshotBoard).mockResolvedValue(null);

    const response = await invoke('board_x');

    // Re-pinning an already-explicit board would throw the owner's hand-curated
    // arrangement away for a snapshot they never asked for, so that case gets
    // the same answer as a board that was never theirs.
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  it('returns 200 with the re-read view on success', async () => {
    vi.mocked(snapshotBoard).mockResolvedValue(VIEW);

    const response = await invoke('board_1');
    const body = await response.json();

    expect(response.status).toBe(200);
    // The route must hand back exactly what snapshotBoard resolved to — the
    // re-read, explicit-membership view — not a patched-in-memory copy of
    // whatever the filter view looked like before the flip.
    expect(body.data).toEqual(JSON.parse(JSON.stringify(VIEW)));
    expect(body.data.board.membership).toBe('explicit');
  });

  it('passes the owner scope built from the session, and the path id, to the service', async () => {
    vi.mocked(snapshotBoard).mockResolvedValue(VIEW);

    await invoke('board_1');

    const call = vi.mocked(snapshotBoard).mock.calls[0];
    expect(call[0]).toEqual({ userId: 'user_a' });
    expect(call[1]).toBe('board_1');
  });

  it('logs the card count from the returned view', async () => {
    vi.mocked(snapshotBoard).mockResolvedValue(VIEW);

    await invoke('board_1');

    expect(routeLog.info).toHaveBeenCalledWith(
      'Resparkable board snapshotted',
      expect.objectContaining({ id: 'board_1', cards: 3 })
    );
  });
});
