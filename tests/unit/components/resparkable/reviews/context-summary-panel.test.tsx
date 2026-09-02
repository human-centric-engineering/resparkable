// @vitest-environment happy-dom

/**
 * ContextSummaryPanel Component Tests
 *
 * The panel's whole job is picking the right row out of a shared `/reviews`
 * list (matching on `entityType` + `entityId` + `archivedAt === null`) and
 * then routing exactly one of two write paths through `apiClient` — accept
 * PATCHes `description` then dismisses, dismiss just dismisses. Both clear
 * the proposal back to the "get a summary" button afterwards.
 *
 * Test Coverage:
 * - No matching row on initial fetch -> renders the "Get a description
 *   summary" button, not the accept/dismiss panel
 * - A matching row on initial fetch -> renders the proposed body and
 *   Accept/Dismiss directly, skipping the button state
 * - Rows with a mismatched entityId or a non-null archivedAt are excluded
 *   from the match
 * - Clicking "Get a description summary" POSTs the summarize path, then
 *   polls `findProposal()` on the module's own interval until a later poll
 *   turns up a match
 * - Accept PATCHes the entity's description with the proposal body, THEN
 *   dismisses the review, THEN clears back to the button state
 * - Dismiss only dismisses the review, then clears back to the button state
 *
 * @see components/resparkable/reviews/context-summary-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ContextSummaryPanel } from '@/components/resparkable/reviews/context-summary-panel';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

// Matches the module's own private constant — kept as a literal here since it
// isn't exported, but the value is asserted against indirectly via how many
// 4s advances are needed to reach a later poll attempt.
const POLL_INTERVAL_MS = 4000;

const ENTITY_TYPE = 'area';
const ENTITY_ID = 'area_1';

function matchingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'review_1',
    body: 'This area has been mostly about winding down the evening routine.',
    archivedAt: null,
    payload: { entityType: ENTITY_TYPE, entityId: ENTITY_ID },
    ...overrides,
  };
}

function renderPanel(currentDescription: string | null = null) {
  return render(
    <ContextSummaryPanel
      entityType={ENTITY_TYPE}
      entityId={ENTITY_ID}
      currentDescription={currentDescription}
    />
  );
}

describe('ContextSummaryPanel', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the "Get a description summary" button when no proposal matches on initial fetch', async () => {
    mockGet.mockResolvedValueOnce([]);

    renderPanel();

    expect(
      await screen.findByRole('button', { name: /get a description summary/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(
      RESPARKABLE_API.REVIEWS,
      expect.objectContaining({ params: { horizon: 'context_summary', limit: 200 } })
    );
  });

  it('renders the proposed body and Accept/Dismiss directly when a matching proposal is found on mount', async () => {
    mockGet.mockResolvedValueOnce([matchingRow()]);

    renderPanel();

    expect(await screen.findByText(matchingRow().body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /get a description summary/i })
    ).not.toBeInTheDocument();
  });

  it('excludes a row with a mismatched entityId even when archived is null', async () => {
    mockGet.mockResolvedValueOnce([
      matchingRow({ id: 'review_2', payload: { entityType: ENTITY_TYPE, entityId: 'area_999' } }),
    ]);

    renderPanel();

    expect(
      await screen.findByRole('button', { name: /get a description summary/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('excludes an otherwise-matching row that has already been archived', async () => {
    mockGet.mockResolvedValueOnce([
      matchingRow({ id: 'review_3', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    renderPanel();

    expect(
      await screen.findByRole('button', { name: /get a description summary/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('queues a summary on click, then picks up a proposal that appears on a later poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    // Mount: no proposal yet.
    mockGet.mockResolvedValueOnce([]);
    mockPost.mockResolvedValueOnce({ queued: true });

    renderPanel();
    const button = await screen.findByRole('button', { name: /get a description summary/i });

    // Poll attempt 1 (after the first 4s sleep): still nothing.
    mockGet.mockResolvedValueOnce([]);
    // Poll attempt 2 (after the second 4s sleep): the workflow has finished.
    mockGet.mockResolvedValueOnce([matchingRow()]);

    await user.click(button);

    expect(mockPost).toHaveBeenCalledWith(
      RESPARKABLE_API.summarizePath(RESPARKABLE_API.AREAS, ENTITY_ID)
    );

    // First poll interval elapses -> attempt 1 finds nothing, loop continues.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();

    // Second poll interval elapses -> attempt 2 finds the proposal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(await screen.findByText(matchingRow().body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    // Exactly 3 GET calls: the initial mount fetch + the two poll attempts.
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('Accept PATCHes the description with the proposal body, then dismisses, then clears to the button state', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValueOnce([matchingRow()]);
    mockPatch.mockResolvedValueOnce({});
    mockPost.mockResolvedValueOnce({});

    renderPanel('Old description');

    const acceptButton = await screen.findByRole('button', { name: 'Accept' });
    await user.click(acceptButton);

    expect(mockPatch).toHaveBeenCalledWith(
      RESPARKABLE_API.itemPath(RESPARKABLE_API.AREAS, ENTITY_ID),
      { body: { description: matchingRow().body } }
    );
    expect(mockPost).toHaveBeenCalledWith(RESPARKABLE_API.dismissReviewPath('review_1'));

    // Ordering matters: the description write must land before the review is
    // dismissed, or a page reload between the two calls could show a
    // dismissed-but-unapplied proposal.
    const patchOrder = mockPatch.mock.invocationCallOrder[0];
    const postOrder = mockPost.mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(postOrder);

    expect(
      await screen.findByRole('button', { name: /get a description summary/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('Dismiss only dismisses the review (no PATCH) and clears to the button state', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValueOnce([matchingRow()]);
    mockPost.mockResolvedValueOnce({});

    renderPanel();

    const dismissButton = await screen.findByRole('button', { name: 'Dismiss' });
    await user.click(dismissButton);

    expect(mockPost).toHaveBeenCalledWith(RESPARKABLE_API.dismissReviewPath('review_1'));
    expect(mockPatch).not.toHaveBeenCalled();

    expect(
      await screen.findByRole('button', { name: /get a description summary/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});
