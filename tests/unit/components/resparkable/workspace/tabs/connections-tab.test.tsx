/**
 * Unit Tests: ConnectionsTab.
 *
 * The one piece of ConnectionsTab's own logic (beyond `useTabFetch` wiring)
 * is `total={connections.data.length}` — the file's own header comment flags
 * that this is deliberately a client-side count, not `meta.total`, because
 * `apiClient.get()` discards `meta`. That derived value is exactly the kind
 * of thing the anti-green-bar lens wants pinned down: it would be trivial to
 * regress into `total={connections.length}` (undefined) or some remnant of
 * a `meta.total` read, and only an assertion on the *computed* prop would
 * catch it.
 *
 * @see components/resparkable/workspace/tabs/connections-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionsTab } from '@/components/resparkable/workspace/tabs/connections-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/connections/connections-view', () => ({
  ConnectionsView: (props: Record<string, unknown>) => (
    <div data-testid="connections-view">{JSON.stringify(props)}</div>
  ),
}));

function endpoint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'task',
    id: 'task_1',
    title: 'Write report',
    subtitle: null,
    archivedAt: null,
    archivedReason: null,
    ...overrides,
  };
}

function connectionRow(id: string) {
  return {
    id,
    kind: 'related',
    status: 'pending',
    origin: 'ai',
    strength: 0.8,
    rationale: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    reviewedAt: null,
    source: endpoint({ id: `${id}_source` }),
    target: endpoint({ id: `${id}_target` }),
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('ConnectionsTab', () => {
  it('requests the connections collection with a 50 limit', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<ConnectionsTab />);

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.CONNECTIONS}?limit=50`)
    );
  });

  it('shows a labelled loading state before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<ConnectionsTab />);

    expect(screen.getByText('Loading connections')).toBeInTheDocument();
  });

  it('renders TabLoadError with the API error message and retries through the hook', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Connections are unavailable.', 'ERR', 500)
    );

    render(<ConnectionsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Connections are unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your connections/)).toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue([connectionRow('c1')]);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('connections-view')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('computes total from the fetched rows, not a meta field', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([
      connectionRow('c1'),
      connectionRow('c2'),
      connectionRow('c3'),
    ]);

    render(<ConnectionsTab />);

    await waitFor(() => expect(screen.getByTestId('connections-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('connections-view').textContent ?? '{}');
    expect(rendered.total).toBe(3);
    expect(rendered.connections).toHaveLength(3);
  });

  it('reports a total of 0 for an empty result, not undefined or NaN', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<ConnectionsTab />);

    await waitFor(() => expect(screen.getByTestId('connections-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('connections-view').textContent ?? '{}');
    expect(rendered.total).toBe(0);
    expect(rendered.connections).toEqual([]);
  });
});
