/**
 * Unit Tests: BoardsTab.
 *
 * Three independent `useTabFetch` calls (boards, active projects, tags), but
 * only `boards` is load-bearing — the tab's own logic is the
 * `status === 'ready' ? data : []` fallback for the other two, letting the
 * board list render before its filter/tag chrome has finished loading
 * rather than blocking on it. That fallback, and which endpoint is which,
 * is what this file pins down; `apiClient.get` is mocked per-endpoint so
 * the three `useTabFetch` calls can resolve independently.
 *
 * @see components/resparkable/workspace/tabs/boards-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BoardsTab } from '@/components/resparkable/workspace/tabs/boards-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/board/boards-list', () => ({
  BoardsList: (props: Record<string, unknown>) => (
    <div data-testid="boards-list">{JSON.stringify(props)}</div>
  ),
}));

function board(id: string) {
  return {
    id,
    name: 'Roadmap',
    slug: 'roadmap',
    description: null,
    columns: null,
    membership: 'explicit',
    filter: null,
    swimlaneBy: null,
    archivedAt: null,
    archivedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function project(id: string) {
  return {
    id,
    name: 'Launch',
    slug: 'launch',
    description: null,
    status: 'active',
    areaId: null,
    priorityScore: 1,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    archivedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function tag(id: string) {
  return { id, name: 'Urgent', slug: 'urgent', colour: '#f00', sortOrder: 0 };
}

/** Routes a mocked `apiClient.get` call to the right fixture by endpoint prefix. */
function mockEndpoints(responses: {
  boards?: unknown[] | Error;
  projects?: unknown[] | Error;
  tags?: unknown[] | Error;
}) {
  vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
    const pick = (value: unknown[] | Error | undefined) =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
    if (endpoint.startsWith(RESPARKABLE_API.TAGS)) return pick(responses.tags);
    if (endpoint.startsWith(RESPARKABLE_API.PROJECTS)) return pick(responses.projects);
    if (endpoint.startsWith(RESPARKABLE_API.BOARDS)) return pick(responses.boards);
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  });
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('BoardsTab', () => {
  it('requests boards, active projects, and tags with their own endpoints', async () => {
    mockEndpoints({ boards: [], projects: [], tags: [] });

    render(<BoardsTab />);

    await waitFor(() => expect(screen.getByTestId('boards-list')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.BOARDS}?limit=100`);
    expect(apiClient.get).toHaveBeenCalledWith(
      `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`
    );
    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.TAGS}?limit=100`);
  });

  it('shows a labelled loading state while boards is still fetching', () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
      if (endpoint.startsWith(RESPARKABLE_API.BOARDS)) return new Promise(() => {});
      return Promise.resolve([]);
    });

    render(<BoardsTab />);

    expect(screen.getByText('Loading boards')).toBeInTheDocument();
  });

  it('renders TabLoadError and retries when boards itself fails to load', async () => {
    const user = userEvent.setup();
    mockEndpoints({
      boards: new APIClientError('Boards are unavailable.', 'ERR', 500),
      projects: [],
      tags: [],
    });

    render(<BoardsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Boards are unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your boards/)).toBeInTheDocument();

    mockEndpoints({ boards: [board('b1')], projects: [], tags: [] });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('boards-list')).toBeInTheDocument());
  });

  it('falls back to empty arrays for projects and tags when they are still loading', async () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
      if (endpoint.startsWith(RESPARKABLE_API.BOARDS)) return Promise.resolve([board('b1')]);
      // Never resolve projects/tags — boards should still render.
      return new Promise(() => {});
    });

    render(<BoardsTab />);

    await waitFor(() => expect(screen.getByTestId('boards-list')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('boards-list').textContent ?? '{}');
    expect(rendered.boards).toEqual([board('b1')]);
    expect(rendered.projects).toEqual([]);
    expect(rendered.tags).toEqual([]);
  });

  it('falls back to empty arrays for projects and tags when those fetches error, without failing the whole tab', async () => {
    mockEndpoints({
      boards: [board('b1')],
      projects: new APIClientError('Projects down.', 'ERR', 500),
      tags: new APIClientError('Tags down.', 'ERR', 500),
    });

    render(<BoardsTab />);

    await waitFor(() => expect(screen.getByTestId('boards-list')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('boards-list').textContent ?? '{}');
    expect(rendered.boards).toEqual([board('b1')]);
    expect(rendered.projects).toEqual([]);
    expect(rendered.tags).toEqual([]);
  });

  it('passes through projects and tags once all three fetches are ready', async () => {
    mockEndpoints({ boards: [board('b1')], projects: [project('p1')], tags: [tag('t1')] });

    render(<BoardsTab />);

    await waitFor(() => expect(screen.getByTestId('boards-list')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('boards-list').textContent ?? '{}');
    expect(rendered.boards).toEqual([board('b1')]);
    expect(rendered.projects).toEqual([project('p1')]);
    expect(rendered.tags).toEqual([tag('t1')]);
  });
});
