// @vitest-environment happy-dom

/**
 * RevisionDrawer Component Tests
 *
 * The drawer is now a thin dialog around <RevisionHistory> — the list, the
 * per-revision diff and restore are covered by revision-history.test.tsx.
 * What is left here is the dialog's own behaviour:
 *
 * - Closed → the history (and therefore its fetch) is not mounted at all
 * - Open → the history mounts and fetches
 * - Re-opening bumps refreshKey so the list reflects revisions written while
 *   the dialog was closed
 * - A restore closes the dialog and forwards onRestored to the page
 * - The retention cap is stated in the dialog copy
 *
 * Mocking:
 * - @/components/admin/orchestration/knowledge/revision-history → a marker
 *   that echoes refreshKey and exposes buttons firing the two callbacks
 *
 * @see components/admin/orchestration/knowledge/revision-drawer.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockRevisionHistory } = vi.hoisted(() => ({ mockRevisionHistory: vi.fn() }));

vi.mock('@/components/admin/orchestration/knowledge/revision-history', () => ({
  RevisionHistory: (props: {
    documentId: string;
    currentContent: string;
    refreshKey?: number;
    onRestored: () => void;
    onAfterRestore?: () => void;
  }) => {
    mockRevisionHistory(props);
    return (
      <div data-testid="revision-history" data-refresh-key={props.refreshKey}>
        <button
          type="button"
          onClick={() => {
            props.onRestored();
            props.onAfterRestore?.();
          }}
        >
          simulate restore
        </button>
      </div>
    );
  },
}));

import { RevisionDrawer } from '@/components/admin/orchestration/knowledge/revision-drawer';

const BASE_PROPS = {
  documentId: 'doc-abc-123',
  currentContent: 'Current document content here.',
  onOpenChange: vi.fn(),
  onRestored: vi.fn(),
};

describe('RevisionDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mount the history while closed, so no revisions are fetched', () => {
    render(<RevisionDrawer {...BASE_PROPS} open={false} />);

    expect(screen.queryByTestId('revision-history')).not.toBeInTheDocument();
    expect(mockRevisionHistory).not.toHaveBeenCalled();
  });

  it('mounts the history with the document id and current content when open', () => {
    render(<RevisionDrawer {...BASE_PROPS} open={true} />);

    expect(screen.getByTestId('revision-history')).toBeInTheDocument();
    expect(mockRevisionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: BASE_PROPS.documentId,
        currentContent: BASE_PROPS.currentContent,
      })
    );
  });

  it('bumps refreshKey on each open so revisions written while closed appear', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RevisionDrawer {...BASE_PROPS} open={false} onOpenChange={onOpenChange} />
    );

    rerender(<RevisionDrawer {...BASE_PROPS} open={true} onOpenChange={onOpenChange} />);
    const firstKey = screen.getByTestId('revision-history').getAttribute('data-refresh-key');

    // Close via the dialog's own handler, then re-open.
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    rerender(<RevisionDrawer {...BASE_PROPS} open={false} onOpenChange={onOpenChange} />);
    rerender(<RevisionDrawer {...BASE_PROPS} open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByTestId('revision-history').getAttribute('data-refresh-key')).not.toBe(
      firstKey
    );
  });

  it('closes itself and forwards onRestored when a restore succeeds', async () => {
    const onOpenChange = vi.fn();
    const onRestored = vi.fn();
    render(
      <RevisionDrawer
        {...BASE_PROPS}
        open={true}
        onOpenChange={onOpenChange}
        onRestored={onRestored}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /simulate restore/i }));

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('states the retention cap so a missing old revision is explained', () => {
    render(<RevisionDrawer {...BASE_PROPS} open={true} />);

    expect(screen.getByText(/only the most recent/i).textContent).toMatch(/50 revisions/i);
  });
});
