/**
 * Unit Tests: ProjectTab.
 *
 * Two `useTabFetch` calls in play — the project view (gates the whole
 * render) and the areas list (a soft dependency that falls back to `[]`
 * when it isn't ready yet, matching how `ProjectDetail` expects it). The
 * view fetch's 404 gets its own inline not-found state rather than the
 * shared `TabLoadError`, per this tab's own header comment — a tab's 404
 * can't call the route group's `notFound()`, which would blow away every
 * other open pane.
 *
 * `ProjectDetail` is mocked to a marker so this file is only about which
 * props ProjectTab computes for it, not that component's own rendering
 * (covered by `project-detail.test.tsx`).
 *
 * @see components/resparkable/workspace/tabs/project-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProjectTab } from '@/components/resparkable/workspace/tabs/project-tab';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectViewWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

const setTabTitle = vi.fn();

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/projects/project-detail', () => ({
  ProjectDetail: ({ view, areas }: { view: ProjectViewWire; areas: AreaWire[] }) => (
    <div data-testid="project-detail">{JSON.stringify({ view, areas })}</div>
  ),
}));

const viewEndpoint = RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'proj_1');
const areasEndpoint = `${RESPARKABLE_API.AREAS}?limit=200`;

const project = {
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

const validView: ProjectViewWire = {
  project,
  area: null,
  tasks: [],
  openTaskCount: 0,
  totalTaskCount: 0,
  related: [],
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
  setTabTitle.mockReset();
  vi.mocked(useWorkspace).mockReturnValue({ setTabTitle } as unknown as ReturnType<
    typeof useWorkspace
  >);
  vi.mocked(apiClient.get).mockReset();
});

describe('ProjectTab', () => {
  it('fetches the project view and shows a loading skeleton first', () => {
    mockGet({});

    render(<ProjectTab tabId="tab_1" id="proj_1" />);

    expect(screen.getByText('Loading project')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(viewEndpoint);
  });

  it('renders an inline not-found state on a 404, not the shared TabLoadError', async () => {
    mockGet({
      [viewEndpoint]: () => Promise.reject(new APIClientError('Not found.', 'NOT_FOUND', 404)),
    });

    render(<ProjectTab tabId="tab_1" id="proj_1" />);

    await waitFor(() => expect(screen.getByText('Project not found')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders TabLoadError for a non-404 failure, with a working retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockGet({
      [viewEndpoint]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new APIClientError('Server unwell.', 'ERR', 500))
          : Promise.resolve(validView);
      },
    });

    render(<ProjectTab tabId="tab_1" id="proj_1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load this project/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('project-detail')).toBeInTheDocument());
  });

  it('falls back to an empty areas array while the areas fetch is still loading', async () => {
    mockGet({ [viewEndpoint]: validView }); // areasEndpoint left pending

    render(<ProjectTab tabId="tab_1" id="proj_1" />);

    await waitFor(() => expect(screen.getByTestId('project-detail')).toBeInTheDocument());
    expect(screen.getByTestId('project-detail')).toHaveTextContent('"areas":[]');
  });

  it('passes the resolved areas through once both fetches are ready', async () => {
    mockGet({ [viewEndpoint]: validView, [areasEndpoint]: [area] });

    render(<ProjectTab tabId="tab_1" id="proj_1" />);

    await waitFor(() => expect(screen.getByTestId('project-detail')).toBeInTheDocument());
    expect(screen.getByTestId('project-detail')).toHaveTextContent('"name":"Home"');
    expect(screen.getByTestId('project-detail')).toHaveTextContent('"name":"Kitchen remodel"');
  });
});
