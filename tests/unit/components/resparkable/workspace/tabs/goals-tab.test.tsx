// @vitest-environment happy-dom

/**
 * Unit Tests: GoalsTab.
 *
 * Two independent `useTabFetch` calls (goals, areas) share the same
 * `apiClient.get` mock, distinguished by which endpoint each requests —
 * `useTabFetch`'s own state machine is covered by `use-tab-fetch.test.ts`.
 * What's worth pinning here is specific to this adapter: only the *goals*
 * fetch drives loading/error (areas is decorative), and areas degrades to
 * `[]` rather than blocking the view when it hasn't resolved yet — the
 * comment in the source calls this out as accepted, not incidental.
 *
 * @see components/resparkable/workspace/tabs/goals-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GoalsTab } from '@/components/resparkable/workspace/tabs/goals-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire, GoalWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/goals/goals-view', () => ({
  GoalsView: ({ goals, areas }: { goals: GoalWire[]; areas: AreaWire[] }) => (
    <div data-testid="goals-view">{JSON.stringify({ goals, areas })}</div>
  ),
}));

const GOALS_ENDPOINT = `${RESPARKABLE_API.GOALS}?limit=200`;
const AREAS_ENDPOINT = `${RESPARKABLE_API.AREAS}?limit=200`;

function makeGoal(overrides: Partial<GoalWire> = {}): GoalWire {
  return {
    id: 'goal_1',
    title: 'Ship the beta',
    description: null,
    horizon: 'quarter',
    parentGoalId: null,
    areaId: null,
    targetDate: null,
    status: 'active',
    lastActivityAt: null,
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

/** Never-resolving promise, for pinning a fetch in its loading state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('GoalsTab', () => {
  it('fetches both goals and areas with a 200 limit', () => {
    vi.mocked(apiClient.get).mockImplementation(() => pending());

    render(<GoalsTab />);

    expect(apiClient.get).toHaveBeenCalledWith(GOALS_ENDPOINT);
    expect(apiClient.get).toHaveBeenCalledWith(AREAS_ENDPOINT);
  });

  it('shows a loading skeleton while the goals fetch is pending, even if areas already resolved', () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === AREAS_ENDPOINT ? Promise.resolve([makeArea()]) : pending()
    );

    render(<GoalsTab />);

    expect(screen.getByText('Loading goals')).toBeInTheDocument();
  });

  it('shows a load error naming your goals and retries only the goals fetch', async () => {
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === GOALS_ENDPOINT
        ? Promise.reject(new APIClientError('Server is down.', 'ERR', 500))
        : Promise.resolve([makeArea()])
    );
    const user = userEvent.setup();

    render(<GoalsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your goals.');

    vi.mocked(apiClient.get).mockReset();
    vi.mocked(apiClient.get).mockResolvedValue([makeGoal()]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('goals-view')).toBeInTheDocument();
    // Retry only re-fires the goals fetch, not a second areas fetch.
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(GOALS_ENDPOINT);
  });

  it('passes goals and areas through once both are ready', async () => {
    const goals = [makeGoal()];
    const areas = [makeArea()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      Promise.resolve(endpoint === GOALS_ENDPOINT ? goals : areas)
    );

    render(<GoalsTab />);

    const view = await screen.findByTestId('goals-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ goals, areas });
  });

  it('defaults areas to an empty array when the areas fetch has not resolved yet', async () => {
    const goals = [makeGoal()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === GOALS_ENDPOINT ? Promise.resolve(goals) : pending()
    );

    render(<GoalsTab />);

    const view = await screen.findByTestId('goals-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ goals, areas: [] });
  });

  it('defaults areas to an empty array when the areas fetch errors', async () => {
    const goals = [makeGoal()];
    vi.mocked(apiClient.get).mockImplementation((endpoint: string) =>
      endpoint === GOALS_ENDPOINT
        ? Promise.resolve(goals)
        : Promise.reject(new APIClientError('Areas down.', 'ERR', 500))
    );

    render(<GoalsTab />);

    const view = await screen.findByTestId('goals-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual({ goals, areas: [] });
  });
});
