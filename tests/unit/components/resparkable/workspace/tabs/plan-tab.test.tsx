/**
 * Unit Tests: PlanTab.
 *
 * Three independent `useTabFetch` calls (time blocks, active projects,
 * areas) share one `apiClient.get` mock, distinguished by endpoint —
 * `useTabFetch`'s own mechanics are covered by `use-tab-fetch.test.ts`.
 * What's this adapter's own logic, and what's pinned here: `day` is this
 * tab's **own** state, taken off `tab.params` with a regex-validated
 * fallback to "today" and written back through `setTabParams` — never the
 * shared browser URL, which is the regression this replaced (two Plan panes
 * read one `useSearchParams()`, so stepping to tomorrow in either stepped
 * both). Then: the from/to range it derives from that day to build the
 * time-blocks endpoint, and that only the blocks fetch drives loading/error
 * while projects/areas degrade to `[]` when not yet ready — same accepted
 * pattern as `GoalsTab`/`InboxTab`.
 *
 * @see components/resparkable/workspace/tabs/plan-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanTab } from '@/components/resparkable/workspace/tabs/plan-tab';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, ProjectWire, TimeBlockWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('@/components/resparkable/plan/day-planner', () => ({
  DayPlanner: ({
    blocks,
    projects,
    areas,
    day,
    onDayChange,
  }: {
    blocks: TimeBlockWire[];
    projects: ProjectWire[];
    areas: AreaWire[];
    day: string;
    onDayChange?: (day: string) => void;
  }) => (
    <div data-testid="day-planner">
      {/* The props live in their own node so the button below doesn't end up
          inside the JSON the assertions parse. */}
      <span data-testid="day-planner-props">
        {JSON.stringify({ blocks, projects, areas, day })}
      </span>
      <button type="button" onClick={() => onDayChange?.('2024-02-02')}>
        next day
      </button>
    </div>
  ),
}));

const setTabParams = vi.fn();

const PROJECTS_ENDPOINT = `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`;
const AREAS_ENDPOINT = `${RESPARKABLE_API.AREAS}?limit=200`;

/** Mirrors the adapter's own from/to derivation, so the test doesn't hard-code a timezone. */
function timeBlocksEndpointFor(day: string): string {
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(`${day}T23:59:59`);
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    limit: '100',
  });
  return `${RESPARKABLE_API.TIME_BLOCKS}?${query.toString()}`;
}

/** Mirrors the adapter's own `todayIso()`, in local time. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${date}`;
}

/** `day` is a prop off `tab.params` now — `undefined` is "the tab carries none". */
function renderPlanTab(day?: string) {
  return render(<PlanTab tabId="tab_1" day={day} />);
}

function makeTimeBlock(overrides: Partial<TimeBlockWire> = {}): TimeBlockWire {
  return {
    id: 'block_1',
    title: 'Deep work',
    taskId: null,
    projectId: null,
    areaId: null,
    startAt: '2024-01-15T09:00:00.000Z',
    endAt: '2024-01-15T11:00:00.000Z',
    source: 'manual',
    notes: null,
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

function makeArea(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Work',
    slug: 'work',
    description: null,
    colour: null,
    sortOrder: 0,
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
  setTabParams.mockReset();
  vi.mocked(useWorkspace).mockReturnValue({ setTabParams } as unknown as ReturnType<
    typeof useWorkspace
  >);
});

describe('PlanTab', () => {
  it('builds the time-blocks endpoint from the day the tab carries', () => {
    const day = '2024-01-15';
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    renderPlanTab(day);

    expect(apiClient.get).toHaveBeenCalledWith(timeBlocksEndpointFor('2024-01-15'));
  });

  it('falls back to today when the tab carries no day', () => {
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    renderPlanTab();

    expect(apiClient.get).toHaveBeenCalledWith(timeBlocksEndpointFor(todayIso()));
  });

  it('falls back to today when the day the tab carries is malformed', () => {
    const day = 'not-a-date';
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    renderPlanTab(day);

    expect(apiClient.get).toHaveBeenCalledWith(timeBlocksEndpointFor(todayIso()));
  });

  it('also fetches active projects and areas', () => {
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    renderPlanTab();

    expect(apiClient.get).toHaveBeenCalledWith(PROJECTS_ENDPOINT);
    expect(apiClient.get).toHaveBeenCalledWith(AREAS_ENDPOINT);
  });

  it('shows a loading skeleton while the time-blocks fetch is pending', () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === PROJECTS_ENDPOINT || endpoint === AREAS_ENDPOINT
        ? Promise.resolve([])
        : pending()
    );

    renderPlanTab();

    expect(screen.getByText('Loading your day')).toBeInTheDocument();
  });

  it('shows a load error naming your day and retries only the time-blocks fetch', async () => {
    const day = '2024-01-15';
    const blocksEndpoint = timeBlocksEndpointFor('2024-01-15');
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === blocksEndpoint
        ? Promise.reject(new APIClientError('Server is down.', 'ERR', 500))
        : Promise.resolve([])
    );
    const user = userEvent.setup();

    renderPlanTab(day);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your day.');

    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue([makeTimeBlock()]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('day-planner')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(blocksEndpoint);
  });

  it('passes blocks, projects, areas and day through once everything is ready', async () => {
    const day = '2024-01-15';
    const blocksEndpoint = timeBlocksEndpointFor('2024-01-15');
    const blocks = [makeTimeBlock()];
    const projects = [makeProject()];
    const areas = [makeArea()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
      if (endpoint === blocksEndpoint) return Promise.resolve(blocks);
      if (endpoint === PROJECTS_ENDPOINT) return Promise.resolve(projects);
      if (endpoint === AREAS_ENDPOINT) return Promise.resolve(areas);
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    renderPlanTab(day);

    await screen.findByTestId('day-planner');
    const view = screen.getByTestId('day-planner-props');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({
      blocks,
      projects,
      areas,
      day: '2024-01-15',
    });
  });

  it('defaults projects and areas to an empty array when those fetches have not resolved yet', async () => {
    const day = '2024-01-15';
    const blocksEndpoint = timeBlocksEndpointFor('2024-01-15');
    const blocks = [makeTimeBlock()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === blocksEndpoint ? Promise.resolve(blocks) : pending()
    );

    renderPlanTab(day);

    await screen.findByTestId('day-planner');
    const view = screen.getByTestId('day-planner-props');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({
      blocks,
      projects: [],
      areas: [],
      day: '2024-01-15',
    });
  });

  it('writes a day change back to this tab, keyed on its own id, not to the URL', async () => {
    const user = userEvent.setup();
    const day = '2024-01-15';
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === timeBlocksEndpointFor(day) ? Promise.resolve([makeTimeBlock()]) : pending()
    );

    renderPlanTab(day);

    await screen.findByTestId('day-planner');
    await user.click(screen.getByRole('button', { name: 'next day' }));

    expect(setTabParams).toHaveBeenCalledWith('tab_1', { day: '2024-02-02' });
  });
});
