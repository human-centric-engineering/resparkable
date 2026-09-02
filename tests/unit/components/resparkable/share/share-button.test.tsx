// @vitest-environment happy-dom

/**
 * Unit Tests: `ShareButton` — the control that opens `ShareDialog`.
 *
 * The dialog has its own test and this one does not repeat it. What is asserted
 * here is the wrapper's whole job:
 *
 * - The dialog is closed until the button is pressed, and nothing is fetched
 *   before then. A list row mounts one of these per row, so a wrapper that
 *   fetched on mount would turn a page of twenty areas into forty requests.
 * - Pressing it opens the dialog **on the right entity**, asserted through the
 *   `entityType`/`entityId` the grants request actually carries rather than
 *   through props. Passing the wrong entity down is the failure a wrapper
 *   introduces, and the only one worth testing at this seam.
 * - `compact` drops the visible word and keeps the accessible name, which is
 *   what makes a row of icon buttons usable. The name always includes the item,
 *   compact or not, because a page carries several of these.
 * - `filterBoard` reaches the dialog, so the board header's §13 mitigations
 *   still render now that they arrive through this component.
 *
 * @see components/resparkable/share/share-button.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ShareButton } from '@/components/resparkable/share/share-button';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
});

/** Every request the dialog made, as URL strings. */
function requestedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

describe('ShareButton', () => {
  it('renders a labelled button and fetches nothing until it is pressed', () => {
    render(<ShareButton entityType="area" entityId="area_1" title="Health" />);

    expect(screen.getByRole('button', { name: 'Share Health' })).toBeInTheDocument();
    // A list row mounts one of these per row. Fetching here would be an N+1.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('opens the dialog on the entity it was given', async () => {
    const user = userEvent.setup();
    render(<ShareButton entityType="goal" entityId="goal_7" title="Take a month off" />);

    await user.click(screen.getByRole('button', { name: 'Share Take a month off' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // The dialog asks who this is shared with. That request is the only place
    // the entity it is actually pointed at becomes observable.
    await waitFor(() => {
      expect(
        requestedUrls().some((url) => url.includes('entityType=goal') && url.includes('goal_7'))
      ).toBe(true);
    });
  });

  it('names the item in the heading rather than the type', async () => {
    const user = userEvent.setup();
    render(<ShareButton entityType="review" entityId="rev_1" title="Tuesday briefing" />);

    await user.click(screen.getByRole('button', { name: 'Share Tuesday briefing' }));

    expect(await screen.findByRole('heading', { name: /Tuesday briefing/ })).toBeInTheDocument();
  });

  it('keeps the accessible name when compact drops the visible word', () => {
    render(<ShareButton compact entityType="area" entityId="area_1" title="Career" />);

    const button = screen.getByRole('button', { name: 'Share Career' });
    // Icon-only: no text node, so the name has to come from aria-label.
    expect(button).toHaveTextContent('');
  });

  it('shows the visible word when it is not compact', () => {
    render(<ShareButton entityType="area" entityId="area_1" title="Career" />);

    expect(screen.getByRole('button', { name: 'Share Career' })).toHaveTextContent('Share');
  });

  it('forwards a filter board so the dialog still renders §13s three mitigations', async () => {
    const user = userEvent.setup();
    render(
      <ShareButton
        entityType="board"
        entityId="board_1"
        title="Work"
        filterBoard={{
          summary: 'Anyone with this link sees tasks in Acme Redesign.',
          cardCount: 13,
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Share Work' }));

    expect(
      await screen.findByText('Anyone with this link sees tasks in Acme Redesign.')
    ).toBeInTheDocument();
    expect(screen.getByText('13 tasks match right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share a snapshot instead' })).toBeInTheDocument();
  });

  it('renders no filter-board warning when there is no filter board', async () => {
    const user = userEvent.setup();
    render(<ShareButton entityType="project" entityId="proj_1" title="Acme Redesign" />);

    await user.click(screen.getByRole('button', { name: 'Share Acme Redesign' }));

    await screen.findByRole('dialog');
    // An explicit board and a project have fixed contents. A warning here would
    // train people to ignore the one that matters.
    expect(screen.queryByRole('button', { name: 'Share a snapshot instead' })).toBeNull();
  });
});
