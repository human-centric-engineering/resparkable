// @vitest-environment happy-dom

/**
 * ArchiveControls Component Tests
 *
 * §11 draws a hard line between archiving (reversible, `DELETE`) and destroying
 * (irreversible, `DELETE ...?permanent=true`), and this component's whole job is
 * to keep that line visible: archiving has no confirmation, destroying always
 * does. Restoring is not just an un-archive either: it goes through a distinct
 * endpoint because it re-queues the item for indexing, which is why the copy
 * beside it warns that meaning-search lags behind.
 *
 * Test Coverage:
 * - Not-archived state shows Archive (no confirmation) → DELETE, then onDone + router.refresh()
 * - Archived state shows Restore → POST .../restore, then onDone + router.refresh()
 * - Destroy requires opening the AlertDialog and confirming → DELETE ?permanent=true
 * - Destroy with `redirectTo` pushes there instead of refreshing (the page can't 404-refresh itself)
 * - Destroy without `redirectTo` refreshes instead
 * - A failed archive call does not call onDone or refresh (SaveStatus carries the error)
 * - `compact` swaps visible text for icon-only, but keeps full-sentence aria-labels
 * - The restore-and-reindex note only appears for an archived, non-compact row
 * - Inside a workspace tab, a destroy calls `workspace.closeTabsAbout`
 *   (whether or not `redirectTo` is set), and the route-backed tab (the one
 *   tab that can't be closed) navigates instead, only when it was about the
 *   deleted record
 *
 * @see components/resparkable/ui/archive-controls.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { useOptionalWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { createMockRouter } from '@/tests/types/mocks';
import type { WorkspaceContextValue } from '@/components/resparkable/workspace/workspace-context';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

// `useOptionalWorkspace` is mocked at the module boundary rather than
// rendered through a real `WorkspaceProvider`: the plain-page tests need it to
// return `null` (no workspace), and the "inside a workspace tab" tests below
// need a `closeTabsAbout` spy to assert against, which a real provider has no
// seam for.
vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useOptionalWorkspace: vi.fn(() => null),
}));

// Whether the control renders under a tab boundary: `true` is a launcher or
// floating tab, `false` (inside a workspace) is the route-backed page. The
// real hook reads a context only a full `TabRefreshBoundary` provides.
vi.mock('@/components/resparkable/workspace/tabs/tab-refresh-context', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/resparkable/workspace/tabs/tab-refresh-context')
  >()),
  useIsInTab: vi.fn(() => true),
}));

import { apiClient } from '@/lib/api/client';
import { useIsInTab } from '@/components/resparkable/workspace/tabs/tab-refresh-context';

const mockDelete = vi.mocked(apiClient.delete);
const mockPost = vi.mocked(apiClient.post);
const mockUseOptionalWorkspace = vi.mocked(useOptionalWorkspace);
const mockRefresh = vi.fn();
const mockPush = vi.fn();

/** A workspace stub carrying only what `ArchiveControls` reads off it. */
function fakeWorkspace(
  overrides: Partial<Pick<WorkspaceContextValue, 'closeTabsAbout'>> = {}
): WorkspaceContextValue {
  return {
    closeTabsAbout: vi.fn(),
    ...overrides,
  } as unknown as WorkspaceContextValue;
}

describe('ArchiveControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockPost.mockResolvedValue(undefined);
    mockUseOptionalWorkspace.mockReturnValue(null);
    vi.mocked(useIsInTab).mockReturnValue(true);
    vi.mocked(useRouter).mockReturnValue(
      createMockRouter({
        refresh: mockRefresh,
        push: mockPush,
      })
    );
  });

  describe('archiving (not archived)', () => {
    it('archives without any confirmation dialog', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith(
          RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'proj_1')
        );
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not call onDone or refresh when the archive request fails', async () => {
      mockDelete.mockRejectedValueOnce(new Error('network down'));
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(screen.getByText('network down')).toBeInTheDocument();
      });
      expect(onDone).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('restoring (archived)', () => {
    it('restores via the dedicated restore endpoint, not a bare PATCH', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /restore q4 launch/i }));

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          RESPARKABLE_API.restorePath(RESPARKABLE_API.PROJECTS, 'proj_1')
        );
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('shows the reindexing note for an archived, non-compact row', () => {
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
        />
      );

      expect(screen.getByText(/re-queues this for indexing/i)).toBeInTheDocument();
    });

    it('hides the reindexing note when compact', () => {
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
          compact
        />
      );

      expect(screen.queryByText(/re-queues this for indexing/i)).not.toBeInTheDocument();
    });
  });

  describe('destroying (permanent)', () => {
    it('requires confirming the AlertDialog before sending the permanent delete', async () => {
      const user = userEvent.setup();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      // The DELETE has not been sent just by opening the trigger.
      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      expect(mockDelete).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith(
          `${RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'proj_1')}?permanent=true`
        );
      });
    });

    it('pushes to redirectTo after a destroy instead of refreshing the (now 404) page', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          redirectTo="/resparkable/projects"
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/resparkable/projects');
      });
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('refreshes instead of pushing when no redirectTo is given', async () => {
      const user = userEvent.setup();
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  /**
   * Inside the workspace, destroying a record closes every tab about it
   * (`closeTabsAbout`), wherever each sits: not just the one the delete was
   * pressed in, and regardless of whether `redirectTo` was passed. The
   * route-backed tab can't be closed (its identity is the URL), so it
   * navigates instead, but only when the delete came from that page. One
   * about the record in another pane is left alone, since navigating it
   * would bring it to the front and pull focus there.
   */
  describe('inside a workspace tab', () => {
    async function destroy(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    }

    it('calls closeTabsAbout for a list row (no redirectTo) and refreshes without pushing', async () => {
      // The regression that matters: a list row has no `redirectTo`, but a
      // destroy from a list must still close any detail tab open elsewhere.
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      await destroy(user);

      await waitFor(() => {
        expect(workspace.closeTabsAbout).toHaveBeenCalledWith({ type: 'project', id: 'proj_1' });
      });
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('closes tabs about the record from a detail tab and refreshes, without moving the URL', async () => {
      // A launcher-opened or floating detail tab (under a tab boundary) passes
      // `redirectTo`, but the URL belongs to the route-backed tab, which may
      // be showing something else entirely in another pane.
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          redirectTo="/resparkable/projects"
        />
      );

      await destroy(user);

      await waitFor(() => {
        expect(workspace.closeTabsAbout).toHaveBeenCalledWith({ type: 'project', id: 'proj_1' });
      });
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('passes a board’s slug, since its tabs are keyed by slug rather than id', async () => {
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.BOARDS}
          id="board_1"
          slug="roadmap"
          label="Q4 launch"
          noun="board"
          archived={false}
          compact
        />
      );

      await destroy(user);

      await waitFor(() => {
        expect(workspace.closeTabsAbout).toHaveBeenCalledWith({
          type: 'board',
          id: 'board_1',
          slug: 'roadmap',
        });
      });
    });

    it('leaves the route-backed page for redirectTo when the delete came from that page', async () => {
      // Where this control renders is the signal, not the stored tree (which
      // other browser windows share): no tab boundary above it means it IS the
      // route-backed page, which would 404 on a refresh.
      const user = userEvent.setup();
      vi.mocked(useIsInTab).mockReturnValue(false);
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          redirectTo="/resparkable/projects"
        />
      );

      await destroy(user);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/resparkable/projects');
      });
      // A refresh first would be a `router.refresh()` into a 404.
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(workspace.closeTabsAbout).toHaveBeenCalledWith({ type: 'project', id: 'proj_1' });
    });

    it('does not call closeTabsAbout when archiving, only when destroying', async () => {
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(workspace.closeTabsAbout).not.toHaveBeenCalled();
    });

    it('does not call closeTabsAbout when restoring', async () => {
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
        />
      );

      await user.click(screen.getByRole('button', { name: /restore q4 launch/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(workspace.closeTabsAbout).not.toHaveBeenCalled();
    });

    it('calls neither closeTabsAbout nor refresh when the delete fails', async () => {
      const user = userEvent.setup();
      const workspace = fakeWorkspace();
      mockUseOptionalWorkspace.mockReturnValue(workspace);
      mockDelete.mockRejectedValueOnce(new Error('boom'));
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          redirectTo="/resparkable/projects"
        />
      );

      await destroy(user);

      // Wait for the failure to surface, not just for the call: asserting
      // straight after the call could run before the rejection is handled.
      expect(await screen.findByText('boom')).toBeInTheDocument();
      expect(workspace.closeTabsAbout).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('compact mode', () => {
    it('hides the visible "Archive" text but keeps the full-sentence aria-label', () => {
      render(
        <ArchiveControls
          collection={RESPARKABLE_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          compact
        />
      );

      const button = screen.getByRole('button', { name: 'Archive Q4 launch' });
      expect(button).toHaveTextContent('');
    });
  });
});
