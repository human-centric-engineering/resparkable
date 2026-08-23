/**
 * Unit Tests: BoardTab.
 *
 * The only kind (besides Graph) the build plan calls out for real logic: a
 * dependent slug → id → view/tags fetch sequence built on `useTabFetch`'s
 * `endpoint: null` ("don't fetch yet"), a not-found branch scoped to the
 * pane rather than a route-level `notFound()`, a 404-on-view branch that
 * reads the same as "board gone" even though it arrives through a
 * different fetch, and an `openTab('boards')` cross-pane action standing in
 * for what would be a `<Link>` on the server page. `BoardView` is mocked to
 * a props-dumping marker so this file stays about BoardTab's own
 * dispatch/derivation, not the card board's own rendering.
 *
 * @see components/resparkable/workspace/tabs/board-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BoardTab } from '@/components/resparkable/workspace/tabs/board-tab';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

const setTabTitle = vi.fn();

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('@/components/resparkable/board/board-view', () => ({
  BoardView: (props: Record<string, unknown>) => (
    <div data-testid="board-view">{JSON.stringify(props)}</div>
  ),
}));

function boardRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'board_1',
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
    ...overrides,
  };
}

function boardView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    board: boardRow(),
    columns: [],
    unplaced: [],
    totalCards: 3,
    ...overrides,
  };
}

const openTab = vi.fn();

/** Routes a mocked `apiClient.get` call to the right fixture by endpoint. */
function mockEndpoints(responses: {
  boards?: unknown[] | Error;
  view?: Record<string, unknown> | Error;
  tags?: unknown[] | Error;
}) {
  vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
    if (endpoint.startsWith(RESPARKABLE_API.TAGS)) {
      return responses.tags instanceof Error
        ? Promise.reject(responses.tags)
        : Promise.resolve(responses.tags ?? []);
    }
    if (endpoint.includes('/view')) {
      return responses.view instanceof Error
        ? Promise.reject(responses.view)
        : Promise.resolve(responses.view);
    }
    if (endpoint.startsWith(RESPARKABLE_API.BOARDS)) {
      return responses.boards instanceof Error
        ? Promise.reject(responses.boards)
        : Promise.resolve(responses.boards ?? []);
    }
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  });
}

beforeEach(() => {
  setTabTitle.mockReset();
  vi.mocked(apiClient.get).mockReset();
  openTab.mockReset();
  vi.mocked(useWorkspace).mockReturnValue({
    openTab,
    setTabTitle,
  } as unknown as ReturnType<typeof useWorkspace>);
});

describe('BoardTab', () => {
  it('shows a labelled loading state while the boards list is still fetching', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    expect(screen.getByText('Loading board')).toBeInTheDocument();
  });

  it('renders TabLoadError and retries when the boards list fails to load', async () => {
    const user = userEvent.setup();
    mockEndpoints({ boards: new APIClientError('Boards down.', 'ERR', 500) });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Boards down.')).toBeInTheDocument();

    mockEndpoints({ boards: [boardRow()], view: boardView(), tags: [] });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
  });

  it('renders a not-found empty state when no board matches the slug', async () => {
    mockEndpoints({ boards: [boardRow({ slug: 'other-slug' })] });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByText('Board not found')).toBeInTheDocument());
    // Never fetches a view/tags for an id that was never resolved.
    expect(apiClient.get).not.toHaveBeenCalledWith(expect.stringContaining('/view'));
  });

  it('does not fetch the view until the boards list resolves the slug to an id', async () => {
    let resolveBoards!: (value: unknown[]) => void;
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
      if (endpoint.startsWith(RESPARKABLE_API.BOARDS) && !endpoint.includes('/view')) {
        return new Promise((resolve) => {
          resolveBoards = resolve;
        });
      }
      return Promise.resolve([]);
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);
    expect(screen.getByText('Loading board')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalledWith(
      RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board_1')
    );

    resolveBoards([boardRow()]);
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(
        RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board_1')
      )
    );
  });

  it('renders a not-found empty state (not a generic error) when the view 404s', async () => {
    mockEndpoints({
      boards: [boardRow()],
      view: new APIClientError('Not found.', 'NOT_FOUND', 404),
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByText('Board not found')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders TabLoadError (not not-found) and retries when the view fails with a non-404 error', async () => {
    const user = userEvent.setup();
    mockEndpoints({
      boards: [boardRow()],
      view: new APIClientError('Server exploded.', 'ERR', 500),
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Server exploded.')).toBeInTheDocument();
    expect(screen.queryByText('Board not found')).not.toBeInTheDocument();

    mockEndpoints({ boards: [boardRow()], view: boardView(), tags: [] });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
  });

  it('renders the board header, pluralised card count, and BoardView once everything resolves', async () => {
    mockEndpoints({
      boards: [boardRow()],
      view: boardView({ totalCards: 5 }),
      tags: [{ id: 'tag_1', name: 'Urgent', slug: 'urgent', colour: '#f00', sortOrder: 0 }],
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByText(/5 cards/)).toBeInTheDocument();
    expect(screen.getByText(/hand-picked, in the order you set/)).toBeInTheDocument();

    const rendered = JSON.parse(screen.getByTestId('board-view').textContent ?? '{}');
    expect(rendered.view.totalCards).toBe(5);
    expect(rendered.allTags).toEqual([
      { id: 'tag_1', name: 'Urgent', slug: 'urgent', colour: '#f00', sortOrder: 0 },
    ]);
  });

  it('renders the singular "card" label when there is exactly one card', async () => {
    mockEndpoints({ boards: [boardRow()], view: boardView({ totalCards: 1 }), tags: [] });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByText(/1 card\b/)).toBeInTheDocument());
    expect(screen.queryByText(/1 cards/)).not.toBeInTheDocument();
  });

  it('describes a filter-backed board as a live query rather than hand-picked', async () => {
    mockEndpoints({
      boards: [boardRow({ membership: 'filter' })],
      view: boardView({ board: boardRow({ membership: 'filter' }) }),
      tags: [],
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() =>
      expect(screen.getByText(/a live query, ordered by what matters most/)).toBeInTheDocument()
    );
  });

  it('falls back to an empty tag list for BoardView while tags is still loading', async () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
      if (endpoint.startsWith(RESPARKABLE_API.TAGS)) return new Promise(() => {});
      if (endpoint.includes('/view')) return Promise.resolve(boardView());
      if (endpoint.startsWith(RESPARKABLE_API.BOARDS)) return Promise.resolve([boardRow()]);
      return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
    });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('board-view').textContent ?? '{}');
    expect(rendered.allTags).toEqual([]);
  });

  it('opens the boards list tab in the same pane when "All boards" is clicked', async () => {
    const user = userEvent.setup();
    mockEndpoints({ boards: [boardRow()], view: boardView(), tags: [] });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /all boards/i }));

    expect(openTab).toHaveBeenCalledWith('boards');
  });

  it('builds CSV and JSON export links from the resolved board id', async () => {
    mockEndpoints({ boards: [boardRow()], view: boardView(), tags: [] });

    render(<BoardTab tabId="tab_1" slug="roadmap" />);

    await waitFor(() => expect(screen.getByTestId('board-view')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /csv/i })).toHaveAttribute(
      'href',
      RESPARKABLE_API.boardExport('board_1', 'csv')
    );
    expect(screen.getByRole('link', { name: /json/i })).toHaveAttribute(
      'href',
      RESPARKABLE_API.boardExport('board_1', 'json')
    );
  });
});
