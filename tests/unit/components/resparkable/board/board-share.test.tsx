// @vitest-environment happy-dom

/**
 * Unit Tests: what `BoardView` shares, and the handoff from card to dialog.
 *
 * Two shareable types meet on this surface and they are not the same share.
 * §13's cascade takes a **board** to its cards' tasks, one level and redacted;
 * a **task** shared on its own carries its own tags and checklist and not its
 * project. Handing somebody the board when they asked for the card, or the
 * reverse, is a leak in one direction and a broken feature in the other, so the
 * entity each control actually points at is what is asserted here.
 *
 * The handoff is the other half. `CardDetailSheet` is itself a dialog, so the
 * share dialog cannot open inside it: the card sheet closes and the share dialog
 * opens in its place. Two stacked focus traps is the failure that avoids, and it
 * is invisible until somebody presses Escape.
 *
 * One thing this environment cannot see: in a real browser the closing card
 * sheet stays mounted for its ~200ms exit animation, overlapping the share
 * dialog, and its `FocusScope` cleanup then fires `onCloseAutoFocus`. The
 * share dialog's own trap bounces focus back, so the symptom is a flicker
 * rather than a stuck trap. jsdom unmounts synchronously, so that window
 * does not exist here and no assertion below can be about it.
 *
 * `DndContext` is mocked away for the same reason `board-drag-end.test.tsx`
 * mocks it: nothing here is about pointer maths, and the real context wants a
 * layout this environment does not have.
 *
 * @see components/resparkable/board/board-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: { children: React.ReactNode }) => props.children,
    DragOverlay: (props: { children?: React.ReactNode }) => props.children ?? null,
  };
});

import * as React from 'react';

import { BoardView } from '@/components/resparkable/board/board-view';
import type { BoardCardWire, BoardViewWire } from '@/lib/framework/resparkable/ui/payloads';

// The share dialog talks to the API with raw `fetch`, not `apiClient`.
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
});

function card(id: string, title: string): BoardCardWire {
  return {
    task: { id, title, status: 'todo', manualBoost: 0, notes: null } as BoardCardWire['task'],
    tags: [],
    checklist: { done: 0, total: 0, items: [] },
    untouchedForMs: 0,
    inColumnSinceMs: null,
    position: 1000,
    cardId: `card_${id}`,
  };
}

function view(overrides: Partial<BoardViewWire> = {}): BoardViewWire {
  return {
    board: {
      id: 'board_1',
      name: 'Work',
      slug: 'work',
      description: null,
      membership: 'explicit',
    },
    columns: [
      {
        status: 'todo',
        label: 'To do',
        wipLimit: null,
        overWip: false,
        cards: [card('task_1', 'File the VAT return')],
      },
    ],
    unplaced: [],
    totalCards: 1,
    ...overrides,
  } as unknown as BoardViewWire;
}

/** Every request the dialog made, as URL strings. */
function requestedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

describe('BoardView sharing', () => {
  it('shares the board from the header, named for the board', async () => {
    const user = userEvent.setup();
    render(<BoardView view={view()} allTags={[]} />);

    await user.click(screen.getByRole('button', { name: 'Share Work' }));

    await waitFor(() => {
      expect(
        requestedUrls().some((url) => url.includes('entityType=board') && url.includes('board_1'))
      ).toBe(true);
    });
  });

  it('warns about a filter board and does not warn about an explicit one', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BoardView view={view()} allTags={[]} />);

    await user.click(screen.getByRole('button', { name: 'Share Work' }));
    await screen.findByRole('dialog');
    // An explicit board's contents are exactly the cards the owner put on it.
    expect(screen.queryByRole('button', { name: 'Share a snapshot instead' })).toBeNull();
    unmount();

    render(
      <BoardView
        view={{
          ...view(),
          board: { ...view().board, membership: 'filter' },
          filterSummary: 'Anyone with this link sees tasks you add later that match.',
        }}
        allTags={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Share Work' }));

    expect(
      await screen.findByText('Anyone with this link sees tasks you add later that match.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share a snapshot instead' })).toBeInTheDocument();
  });

  it('closes the card sheet and shares the task, not the board', async () => {
    const user = userEvent.setup();
    render(<BoardView view={view()} allTags={[]} />);

    // One card on this board, so one 'Open'.
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'File the VAT return' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Share File the VAT return' }));

    // The card sheet is gone and the share dialog replaced it. Asserted on the
    // *content* rather than on a dialog count, because a count cannot fail
    // here: jsdom reports `animationName: none`, so Radix's `Presence`
    // unmounts the closing sheet synchronously and the two can never overlap.
    // In a real browser they do overlap for the ~200ms exit animation
    // `components/ui/dialog.tsx` sets, which is the reason the handoff exists
    // and not something this environment can observe.
    expect(await screen.findByRole('heading', { name: /Share/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'File the VAT return' })).toBeNull();
    // The sheet's own controls are gone with it.
    expect(screen.queryByRole('button', { name: 'Add this step' })).toBeNull();

    // The task, at its own id. Sharing the board here would hand over every
    // other card on it.
    await waitFor(() => {
      expect(
        requestedUrls().some((url) => url.includes('entityType=task') && url.includes('task_1'))
      ).toBe(true);
    });
    expect(requestedUrls().some((url) => url.includes('entityType=board'))).toBe(false);
  });
});
