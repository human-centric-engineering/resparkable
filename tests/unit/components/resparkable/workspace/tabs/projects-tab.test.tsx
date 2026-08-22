/**
 * Unit Tests: ProjectsTab.
 *
 * The own logic worth pinning down: `status` is this tab's **own** state, off
 * `tab.params` rather than the shared browser URL (the regression that drove
 * the change: two Projects panes read one `useSearchParams()`, so changing the
 * filter in either changed both), only a value from `PROJECT_STATUSES` is
 * trusted, and a change writes back through `setTabParams` keyed on this tab's
 * id — never `router.push`. The query string built for the projects fetch, and
 * the areas fallback-to-`[]` while that second fetch isn't ready, are the other
 * two things this file is about.
 *
 * `ProjectsView` is mocked to a marker that also exposes its `onStatusChange`
 * prop as a button, so the write-back can be exercised without depending on
 * that component's own Select rendering (covered by `projects-view.test.tsx`).
 *
 * @see components/resparkable/workspace/tabs/projects-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProjectsTab } from '@/components/resparkable/workspace/tabs/projects-tab';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('@/components/resparkable/projects/projects-view', () => ({
  ProjectsView: ({
    projects,
    areas,
    status,
    onStatusChange,
  }: {
    projects: ProjectWire[];
    areas: AreaWire[];
    status: string | null;
    onStatusChange?: (status: string | null) => void;
  }) => (
    <div data-testid="projects-view">
      {JSON.stringify({ projects, areas, status })}
      <button type="button" onClick={() => onStatusChange?.('paused')}>
        filter paused
      </button>
      <button type="button" onClick={() => onStatusChange?.(null)}>
        filter all
      </button>
    </div>
  ),
}));

const setTabParams = vi.fn();

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
  setTabParams.mockReset();
  vi.mocked(useWorkspace).mockReturnValue({ setTabParams } as unknown as ReturnType<
    typeof useWorkspace
  >);
});

describe('ProjectsTab', () => {
  it('fetches limit=200 with no status filter when the tab carries none', () => {
    mockGet({});

    render(<ProjectsTab tabId="tab_1" status={null} />);

    expect(screen.getByText('Loading projects')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('adds status to the query string when the tab carries a recognised status', () => {
    mockGet({});

    render(<ProjectsTab tabId="tab_1" status="active" />);

    expect(apiClient.get).toHaveBeenCalledWith(
      `${RESPARKABLE_API.PROJECTS}?limit=200&status=active`
    );
  });

  it('treats an unrecognised status value as no filter at all', () => {
    mockGet({});

    render(<ProjectsTab tabId="tab_1" status="not-a-real-status" />);

    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('renders TabLoadError with the "your projects" label when the fetch fails', async () => {
    mockGet({
      [`${RESPARKABLE_API.PROJECTS}?limit=200`]: () =>
        Promise.reject(new APIClientError('Server unwell.', 'ERR', 500)),
    });

    render(<ProjectsTab tabId="tab_1" status={null} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load your projects/)).toBeInTheDocument();
  });

  it('falls back to an empty areas array while the areas fetch is still loading', async () => {
    mockGet({ [`${RESPARKABLE_API.PROJECTS}?limit=200`]: [project] });

    render(<ProjectsTab tabId="tab_1" status={null} />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    expect(screen.getByTestId('projects-view')).toHaveTextContent('"areas":[]');
  });

  it('passes the parsed projects, areas, and status through once ready', async () => {
    mockGet({
      [`${RESPARKABLE_API.PROJECTS}?limit=200&status=paused`]: [project],
      [`${RESPARKABLE_API.AREAS}?limit=200`]: [area],
    });

    render(<ProjectsTab tabId="tab_1" status="paused" />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    const content = screen.getByTestId('projects-view');
    expect(content).toHaveTextContent('"status":"paused"');
    expect(content).toHaveTextContent('"name":"Kitchen remodel"');
    expect(content).toHaveTextContent('"name":"Home"');
  });

  it('writes a status change back to this tab, keyed on its own id', async () => {
    const user = userEvent.setup();
    mockGet({ [`${RESPARKABLE_API.PROJECTS}?limit=200`]: [project] });

    render(<ProjectsTab tabId="tab_7" status={null} />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'filter paused' }));

    expect(setTabParams).toHaveBeenCalledWith('tab_7', { status: 'paused' });
  });

  it('clears the status key rather than storing a null, so the tab still dedupes', async () => {
    const user = userEvent.setup();
    mockGet({ [`${RESPARKABLE_API.PROJECTS}?limit=200&status=paused`]: [project] });

    render(<ProjectsTab tabId="tab_7" status="paused" />);

    await waitFor(() => expect(screen.getByTestId('projects-view')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'filter all' }));

    expect(setTabParams).toHaveBeenCalledWith('tab_7', { status: undefined });
  });
});
