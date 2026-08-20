/**
 * Unit Tests: ProjectsTab.
 *
 * The own logic worth pinning down: `status` is read straight off the real
 * URL (this tab's own header comment explains why — `ProjectsView` changes
 * it via `router.push`, unmodified), and only a value from
 * `PROJECT_STATUSES` is trusted — anything else is treated as "no filter"
 * rather than forwarded to the API or the view. The query string built for
 * the projects fetch, and the areas fallback-to-`[]` while that second
 * fetch isn't ready, are the other two things this file is about.
 *
 * `ProjectsView` is mocked to a marker so this file stays about ProjectsTab's
 * own state wiring, not that component's own rendering (covered by
 * `projects-view.test.tsx`).
 *
 * @see components/resparkable/workspace/tabs/projects-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';

import { ProjectsTab } from '@/components/resparkable/workspace/tabs/projects-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/projects/projects-view', () => ({
  ProjectsView: ({
    projects,
    areas,
    status,
  }: {
    projects: ProjectWire[];
    areas: AreaWire[];
    status: string | null;
  }) => <div data-testid="projects-view">{JSON.stringify({ projects, areas, status })}</div>,
}));

const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;

const project: ProjectWire = {
  id: 'proj_1',
  name: 'Kitchen remodel',
  slug: 'kitchen-remodel',
  description: null,
  status: 'active',
  areaId: null,
  priorityScore: 0.8,
  lastActivityAt: null,
  closedAt: null,
  snoozedUntil: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const area: AreaWire = {
  id: 'area_1',
  name: 'Home',
  slug: 'home',
  description: null,
  colour: null,
  sortOrder: 0,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function mockGet(responses: Record<string, unknown>) {
  vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
    const entry = responses[endpoint];
    if (entry === undefined) return new Promise(() => {}); // left pending on purpose
    return typeof entry === 'function'
      ? (entry as () => Promise<unknown>)()
      : Promise.resolve(entry);
  });
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  mockedSearchParams.mockReturnValue(new URLSearchParams());
});

describe('ProjectsTab', () => {
  it('fetches limit=200 with no status filter when the URL has none', () => {
    mockGet({});

    render(<ProjectsTab />);

    expect(screen.getByText('Loading projects')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('adds status to the query string when the URL carries a recognised status', () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams('status=active'));
    mockGet({});

    render(<ProjectsTab />);

    expect(apiClient.get).toHaveBeenCalledWith(
      `${RESPARKABLE_API.PROJECTS}?limit=200&status=active`
    );
  });

  it('treats an unrecognised status value as no filter at all', () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams('status=not-a-real-status'));
    mockGet({});

    render(<ProjectsTab />);

    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('renders TabLoadError with the "your projects" label when the fetch fails', async () => {
    mockGet({
      [`${RESPARKABLE_API.PROJECTS}?limit=200`]: () =>
        Promise.reject(new APIClientError('Server unwell.', 'ERR', 500)),
    });

    render(<ProjectsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load your projects/)).toBeInTheDocument();
  });

  it('falls back to an empty areas array while the areas fetch is still loading', async () => {
    mockGet({ [`${RESPARKABLE_API.PROJECTS}?limit=200`]: [project] });

    render(<ProjectsTab />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    expect(screen.getByTestId('projects-view')).toHaveTextContent('"areas":[]');
  });

  it('passes the parsed projects, areas, and status through once ready', async () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams('status=paused'));
    mockGet({
      [`${RESPARKABLE_API.PROJECTS}?limit=200&status=paused`]: [project],
      [`${RESPARKABLE_API.AREAS}?limit=200`]: [area],
    });

    render(<ProjectsTab />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    const content = screen.getByTestId('projects-view');
    expect(content).toHaveTextContent('"status":"paused"');
    expect(content).toHaveTextContent('"name":"Kitchen remodel"');
    expect(content).toHaveTextContent('"name":"Home"');
  });
});
