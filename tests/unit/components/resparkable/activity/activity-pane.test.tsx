/**
 * Unit Tests: ActivityPane.
 *
 * `useTabFetch`'s own loading/error/retry contract is pinned down in
 * `use-tab-fetch.test.ts` — what this file covers is what `ActivityPane`
 * does with it: rendering one `DiscoveryCard` per pending connection, the
 * count line, and the accept/reject round trip — optimistic removal that
 * rolls back (with the server's message shown) when the PATCH fails, and
 * without ever calling `router.refresh()`, since there is no route behind
 * this pane to refresh.
 *
 * @see components/resparkable/activity/activity-pane.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ActivityPane } from '@/components/resparkable/activity/activity-pane';
import type { ConnectionRowWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: vi.fn(), patch: vi.fn() },
  };
});

import { apiClient, APIClientError } from '@/lib/api/client';

const mockedGet = apiClient.get as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

function row(overrides: Partial<ConnectionRowWire> = {}): ConnectionRowWire {
  return {
    id: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both discuss the Q4 filing',
    createdAt: '2026-07-20T09:00:00.000Z',
    reviewedAt: null,
    source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
    target: { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: null, archivedAt: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'link_1' });
});

describe('ActivityPane', () => {
  it('shows a skeleton while loading', () => {
    mockedGet.mockReturnValue(new Promise(() => {}));
    render(<ActivityPane />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Loading activity')).toBeInTheDocument();
  });

  it('shows a retryable error when the fetch fails', async () => {
    mockedGet.mockRejectedValue(new APIClientError('offline'));
    render(<ActivityPane />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('offline')).toBeInTheDocument();

    mockedGet.mockResolvedValue([row()]);
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
  });

  it('renders the empty state when nothing is waiting', async () => {
    mockedGet.mockResolvedValue([]);
    render(<ActivityPane />);

    await waitFor(() => expect(screen.getByText('Nothing waiting')).toBeInTheDocument());
  });

  it('renders one card per connection, with a singular count', async () => {
    mockedGet.mockResolvedValue([row()]);
    render(<ActivityPane />);

    await waitFor(() =>
      expect(screen.getByText('1 discovery waiting on a decision.')).toBeInTheDocument()
    );
    expect(screen.getByText('A note')).toBeInTheDocument();
  });

  it('pluralises more than one waiting discovery', async () => {
    mockedGet.mockResolvedValue([row({ id: 'link_1' }), row({ id: 'link_2' })]);
    render(<ActivityPane />);

    await waitFor(() =>
      expect(screen.getByText('2 discoveries waiting on a decision.')).toBeInTheDocument()
    );
  });

  it('removes an accepted card immediately and PATCHes it', async () => {
    mockedGet.mockResolvedValue([row()]);
    const user = userEvent.setup();
    render(<ActivityPane />);

    await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept this connection' }));

    await waitFor(() => expect(screen.getByText('Nothing waiting')).toBeInTheDocument());
    expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/links/link_1', {
      body: { status: 'accepted' },
    });
  });

  it('rejects with a tombstone PATCH', async () => {
    mockedGet.mockResolvedValue([row()]);
    const user = userEvent.setup();
    render(<ActivityPane />);

    await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
    await user.click(
      screen.getByRole('button', { name: 'Not related — don’t suggest this again' })
    );

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/links/link_1', {
        body: { status: 'rejected' },
      })
    );
  });

  it('brings the card back and shows the error when the decision fails to save', async () => {
    mockedGet.mockResolvedValue([row()]);
    mockedPatch.mockRejectedValue(new Error('link not found'));
    const user = userEvent.setup();
    render(<ActivityPane />);

    await waitFor(() => expect(screen.getByText('A note')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept this connection' }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('A note')).toBeInTheDocument();
  });
});
