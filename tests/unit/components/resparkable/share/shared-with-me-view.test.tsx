// @vitest-environment happy-dom

/**
 * Unit Tests: `SharedWithMeView` — the grantee's list of what others handed them.
 *
 * The behaviours under test are the ones that make this list different from
 * every other Resparkable list, per the component's own docblock:
 *
 *   - Every row names its **owner**. That is the one thing a public link never
 *     shows, and the reason a named grant exists as a mechanism at all.
 *   - `role: 'commenter'` earns a "you can comment" badge; `viewer` earns none.
 *   - An archived item says so, rather than looking indistinguishable from a
 *     live one.
 *   - The search box is a substring match over what was shared, not the
 *     owner's hybrid semantic search — so an empty query restores the full
 *     list rather than fetching, a failed request surfaces an error instead of
 *     crashing, a response that fails the Zod parse does the same, and a
 *     genuine zero-hit result says "matches words as they are written" rather
 *     than a generic empty state.
 *
 * @see components/resparkable/share/shared-with-me-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SharedWithMeView } from '@/components/resparkable/share/shared-with-me-view';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type {
  SharedWithMeItemWire,
  SharedSearchHitWire,
} from '@/lib/framework/resparkable/ui/payloads';

// ─── Fetch mock ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSharedItem(
  itemOverrides: Partial<SharedWithMeItemWire['item']> = {},
  entryOverrides: Partial<Omit<SharedWithMeItemWire, 'item' | 'owner'>> = {},
  ownerOverrides: Partial<SharedWithMeItemWire['owner']> = {}
): SharedWithMeItemWire {
  return {
    item: {
      entityType: 'project',
      id: 'item-1',
      title: 'Acme Redesign',
      body: null,
      status: 'active',
      dueAt: null,
      horizon: null,
      archived: false,
      updatedAt: '2026-01-01T00:00:00Z',
      tags: [],
      checklist: null,
      ...itemOverrides,
    },
    owner: {
      id: 'owner-1',
      name: 'Jane Owner',
      email: 'jane@example.com',
      ...ownerOverrides,
    },
    role: 'viewer',
    canComment: false,
    includeTaskDetail: false,
    sharedAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    ...entryOverrides,
  };
}

function makeSearchHit(overrides: Partial<SharedSearchHitWire> = {}): SharedSearchHitWire {
  const base = makeSharedItem();
  return {
    item: base.item,
    owner: base.owner,
    via: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('SharedWithMeView', () => {
  describe('empty state', () => {
    it('shows the empty state when there are no items', () => {
      render(<SharedWithMeView items={[]} />);

      expect(screen.getByText('Nothing has been shared with you')).toBeInTheDocument();
    });

    it('does not show the empty state when there is at least one item', () => {
      render(<SharedWithMeView items={[makeSharedItem()]} />);

      expect(screen.queryByText('Nothing has been shared with you')).not.toBeInTheDocument();
    });
  });

  describe('who shared it', () => {
    it('names the owner on each row — a public link never shows this', () => {
      render(
        <SharedWithMeView
          items={[makeSharedItem({}, {}, { name: 'Jane Owner', email: 'jane@example.com' })]}
        />
      );

      expect(screen.getByText(/Shared by Jane Owner/)).toBeInTheDocument();
    });

    it('falls back to the email when the owner has no name', () => {
      render(
        <SharedWithMeView
          items={[makeSharedItem({}, {}, { name: null, email: 'noname@example.com' })]}
        />
      );

      expect(screen.getByText(/Shared by noname@example.com/)).toBeInTheDocument();
    });
  });

  describe('role badge', () => {
    it('shows a "you can comment" badge for a commenter grant', () => {
      render(<SharedWithMeView items={[makeSharedItem({}, { role: 'commenter' })]} />);

      expect(screen.getByText('you can comment')).toBeInTheDocument();
    });

    it('shows no comment badge for a viewer grant', () => {
      render(<SharedWithMeView items={[makeSharedItem({}, { role: 'viewer' })]} />);

      expect(screen.queryByText('you can comment')).not.toBeInTheDocument();
    });
  });

  describe('archived items', () => {
    it('says the item was archived by its owner', () => {
      render(<SharedWithMeView items={[makeSharedItem({ archived: true })]} />);

      expect(screen.getByText('archived by its owner')).toBeInTheDocument();
    });

    it('says nothing about archiving for a live item', () => {
      render(<SharedWithMeView items={[makeSharedItem({ archived: false })]} />);

      expect(screen.queryByText('archived by its owner')).not.toBeInTheDocument();
    });
  });

  describe('search', () => {
    it('submitting a query fetches the search endpoint and renders the hit', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [makeSearchHit({ item: { ...makeSharedItem().item, title: 'Found Task' } })],
        })
      );

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.type(
        screen.getByLabelText('Match words in what has been shared with you'),
        'urgent'
      );
      await user.click(screen.getByRole('button', { name: /match words/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      expect(mockFetch).toHaveBeenCalledWith(
        `${RESPARKABLE_API.SHARED_SEARCH}?q=${encodeURIComponent('urgent')}`
      );

      expect(await screen.findByText('Found Task')).toBeInTheDocument();
      // The un-searched item no longer shows: hits replace the full list.
      expect(screen.queryByText('Acme Redesign')).not.toBeInTheDocument();
    });

    it('an empty query does not fetch and leaves the full list showing', async () => {
      const user = userEvent.setup();

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.click(screen.getByRole('button', { name: /match words/i }));

      expect(mockFetch).not.toHaveBeenCalled();
      expect(screen.getByText('Acme Redesign')).toBeInTheDocument();
    });

    it('clearing a query after a search restores the full list', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [makeSearchHit({ item: { ...makeSharedItem().item, title: 'Found Task' } })],
        })
      );

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      const box = screen.getByLabelText('Match words in what has been shared with you');
      await user.type(box, 'urgent');
      await user.click(screen.getByRole('button', { name: /match words/i }));
      expect(await screen.findByText('Found Task')).toBeInTheDocument();

      await user.clear(box);
      await user.click(screen.getByRole('button', { name: /match words/i }));

      // Still only the one fetch from the first, non-empty submission.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Acme Redesign')).toBeInTheDocument();
      expect(screen.queryByText('Found Task')).not.toBeInTheDocument();
    });

    it('renders an error and does not crash when the search request fails', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: 'INTERNAL_ERROR' } }, 500)
      );

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.type(
        screen.getByLabelText('Match words in what has been shared with you'),
        'urgent'
      );
      await user.click(screen.getByRole('button', { name: /match words/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not search what has been shared with you.'
      );
    });

    it('renders an error rather than garbage when the payload fails the Zod parse', async () => {
      const user = userEvent.setup();
      // `success: true` with a `data` shape the schema rejects — missing every
      // required field on a search hit.
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [{ nonsense: true }] }));

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.type(
        screen.getByLabelText('Match words in what has been shared with you'),
        'urgent'
      );
      await user.click(screen.getByRole('button', { name: /match words/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not read the search results.'
      );
      // Nothing from the malformed payload renders as content.
      expect(screen.queryByText('nonsense')).not.toBeInTheDocument();
    });

    it('renders an error and does not crash when the fetch itself throws', async () => {
      const user = userEvent.setup();
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.type(
        screen.getByLabelText('Match words in what has been shared with you'),
        'urgent'
      );
      await user.click(screen.getByRole('button', { name: /match words/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not search what has been shared with you.'
      );
    });

    it('the "Clear" button resets the query and restores the full list', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [makeSearchHit({ item: { ...makeSharedItem().item, title: 'Found Task' } })],
        })
      );

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      const box = screen.getByLabelText('Match words in what has been shared with you');
      await user.type(box, 'urgent');
      await user.click(screen.getByRole('button', { name: /match words/i }));
      expect(await screen.findByText('Found Task')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Clear' }));

      expect(box).toHaveValue('');
      expect(screen.getByText('Acme Redesign')).toBeInTheDocument();
      expect(screen.queryByText('Found Task')).not.toBeInTheDocument();
      // Clear never fetches — it just resets local state.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('renders the "matches words as they are written" copy for zero hits, not a generic empty state', async () => {
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

      render(<SharedWithMeView items={[makeSharedItem()]} />);

      await user.type(
        screen.getByLabelText('Match words in what has been shared with you'),
        'nothing matches this'
      );
      await user.click(screen.getByRole('button', { name: /match words/i }));

      expect(await screen.findByText(/matches words as they are written/i)).toBeInTheDocument();
      expect(screen.queryByText('Nothing has been shared with you')).not.toBeInTheDocument();
    });
  });
});
