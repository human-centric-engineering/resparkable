// @vitest-environment happy-dom

/**
 * ArchiveControls Component Tests
 *
 * §11 draws a hard line between archiving (reversible, `DELETE`) and destroying
 * (irreversible, `DELETE ...?permanent=true`), and this component's whole job is
 * to keep that line visible: archiving has no confirmation, destroying always
 * does. Restoring is not just an un-archive either — it goes through a distinct
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
 *
 * @see components/resparkable/ui/archive-controls.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { TabCloseProvider } from '@/components/resparkable/workspace/tabs/tab-close-context';
import { WorkspaceProvider } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockDelete = vi.mocked(apiClient.delete);
const mockPost = vi.mocked(apiClient.post);
const mockRefresh = vi.fn();
const mockPush = vi.fn();

describe('ArchiveControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockPost.mockResolvedValue(undefined);
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
   * Inside the workspace, a detail view's own tab should not survive the thing
   * it is about. It used to: the destroy announced the change, the tab
   * refetched, got a 404, and sat on its "not found" empty state until someone
   * closed it by hand.
   *
   * `redirectTo` is the guard for all of this. It means "this surface is about
   * this item", which is true of the two detail views and false of every list.
   */
  describe('inside a workspace tab', () => {
    function renderInTab(props: { redirectTo?: string; archived?: boolean }, close: () => void) {
      return render(
        <TabCloseProvider close={close}>
          <ArchiveControls
            collection={RESPARKABLE_API.PROJECTS}
            id="proj_1"
            label="Q4 launch"
            noun="project"
            archived={props.archived ?? false}
            {...(props.redirectTo ? { redirectTo: props.redirectTo } : {})}
          />
        </TabCloseProvider>
      );
    }

    async function destroy(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    }

    it('closes its own tab instead of leaving it on "not found"', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      renderInTab({ redirectTo: '/resparkable/projects' }, close);

      await destroy(user);

      await waitFor(() => {
        expect(close).toHaveBeenCalledTimes(1);
      });
      // Not the URL. That is the tree's single route-backed tab, and moving it
      // would replace whatever some *other* pane was showing.
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('announces the change as well, so other panes showing it catch up', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      renderInTab({ redirectTo: '/resparkable/projects' }, close);

      await destroy(user);

      // `useResparkableRefresh` falls back to `router.refresh()` with no
      // boundary above it, which is what this asserts on — the announcement
      // happening at all is the point, not which arm it took.
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
    });

    it('does NOT close the tab for a list row, which has no redirectTo', async () => {
      // The regression that matters. Without the `redirectTo` guard, deleting
      // one project from a Projects list would close the Projects tab.
      const user = userEvent.setup();
      const close = vi.fn();
      renderInTab({}, close);

      await destroy(user);

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(close).not.toHaveBeenCalled();
    });

    it('does not close the tab when archiving, only when destroying', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      renderInTab({ redirectTo: '/resparkable/projects' }, close);

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(close).not.toHaveBeenCalled();
    });

    it('does not close the tab when restoring', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      renderInTab({ redirectTo: '/resparkable/projects', archived: true }, close);

      await user.click(screen.getByRole('button', { name: /restore q4 launch/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(close).not.toHaveBeenCalled();
    });

    it('navigates instead of closing for the route-backed tab, which has no closer', async () => {
      // The one tab in the tree whose identity IS the browser URL. It renders
      // the real server page, so nothing can hand it a closer — and it does
      // not need one: moving the URL changes that tab and nothing else, which
      // is pane-local in exactly the way the old blanket "never push inside
      // the workspace" rule assumed was impossible.
      const user = userEvent.setup();
      render(
        <WorkspaceProvider>
          <ArchiveControls
            collection={RESPARKABLE_API.PROJECTS}
            id="proj_1"
            label="Q4 launch"
            noun="project"
            archived={false}
            redirectTo="/resparkable/projects"
          />
        </WorkspaceProvider>
      );

      await destroy(user);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/resparkable/projects');
      });
      // No `router.refresh()` first. That would be a refresh into a 404
      // immediately before navigating away, flashing the not-found page.
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('leaves the tab open when the delete fails', async () => {
      const user = userEvent.setup();
      const close = vi.fn();
      mockDelete.mockRejectedValueOnce(new Error('boom'));
      renderInTab({ redirectTo: '/resparkable/projects' }, close);

      await destroy(user);

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalled();
      });
      // A tab that vanishes on a failed delete takes the error message with it.
      expect(close).not.toHaveBeenCalled();
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
