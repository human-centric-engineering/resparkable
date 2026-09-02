// @vitest-environment happy-dom

/**
 * Unit Tests: InboxTab.
 *
 * Two independent `useTabFetch` calls (inbox, active projects) share one
 * `apiClient.get` mock, distinguished by endpoint — `useTabFetch`'s own
 * mechanics are covered by `use-tab-fetch.test.ts`. This adapter's own
 * logic, per its header comment: only the inbox fetch is load-bearing for
 * loading/error, and a failed or still-pending projects fetch degrades to
 * `[]` rather than blocking the inbox.
 *
 * @see components/resparkable/workspace/tabs/inbox-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InboxTab } from '@/components/resparkable/workspace/tabs/inbox-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { InboxPayloadWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/inbox/inbox-view', () => ({
  InboxView: ({
    payload,
    projects,
  }: {
    payload: InboxPayloadWire;
    projects: Array<{ id: string; name: string }>;
  }) => <div data-testid="inbox-view">{JSON.stringify({ payload, projects })}</div>,
}));

const INBOX_ENDPOINT = RESPARKABLE_API.INBOX;
const PROJECTS_ENDPOINT = `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`;

function makeInboxPayload(overrides: Partial<InboxPayloadWire> = {}): InboxPayloadWire {
  return {
    generatedAt: '2024-01-01T00:00:00.000Z',
    total: 0,
    items: [],
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    id: 'proj_1',
    name: 'Launch',
    slug: 'launch',
    description: null,
    status: 'active',
    areaId: null,
    priorityScore: 0,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    archivedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('InboxTab', () => {
  it('fetches the inbox and the active projects list', () => {
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    render(<InboxTab />);

    expect(apiClient.get).toHaveBeenCalledWith(INBOX_ENDPOINT);
    expect(apiClient.get).toHaveBeenCalledWith(PROJECTS_ENDPOINT);
  });

  it('shows a loading skeleton while the inbox fetch is pending, even if projects already resolved', () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === PROJECTS_ENDPOINT ? Promise.resolve([makeProject()]) : pending()
    );

    render(<InboxTab />);

    expect(screen.getByText('Loading inbox')).toBeInTheDocument();
  });

  it('shows a load error naming your inbox and retries only the inbox fetch', async () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === INBOX_ENDPOINT
        ? Promise.reject(new APIClientError('Server is down.', 'ERR', 500))
        : Promise.resolve([makeProject()])
    );
    const user = userEvent.setup();

    render(<InboxTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your inbox.');

    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue(makeInboxPayload());
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('inbox-view')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(INBOX_ENDPOINT);
  });

  it('passes the inbox payload and active projects through once both are ready', async () => {
    const payload = makeInboxPayload({ total: 1 });
    const projects = [makeProject()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      Promise.resolve(endpoint === INBOX_ENDPOINT ? payload : projects)
    );

    render(<InboxTab />);

    const view = await screen.findByTestId('inbox-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ payload, projects });
  });

  it('defaults projects to an empty array when the projects fetch has not resolved yet', async () => {
    const payload = makeInboxPayload();
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === INBOX_ENDPOINT ? Promise.resolve(payload) : pending()
    );

    render(<InboxTab />);

    const view = await screen.findByTestId('inbox-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ payload, projects: [] });
  });

  it('defaults projects to an empty array when the projects fetch errors', async () => {
    const payload = makeInboxPayload();
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === INBOX_ENDPOINT
        ? Promise.resolve(payload)
        : Promise.reject(new APIClientError('Projects down.', 'ERR', 500))
    );

    render(<InboxTab />);

    const view = await screen.findByTestId('inbox-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ payload, projects: [] });
  });
});
