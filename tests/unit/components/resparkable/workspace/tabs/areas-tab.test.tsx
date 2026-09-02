// @vitest-environment happy-dom

/**
 * Unit Tests: AreasTab.
 *
 * AreasTab does no mapping of its own — it fetches, validates via
 * `useTabFetch`, and hands the result straight to `AreasView`. So the thing
 * worth pinning down here isn't a transformation (there isn't one) but the
 * wiring: the right endpoint is requested, the loading/error/ready states
 * from the real hook drive the right branch, and `AreasView` receives
 * exactly the validated data — not the raw fetch response.
 *
 * `AreasView` is mocked to a marker that dumps its props, matching how
 * `tab-content.test.tsx` treats adapters it isn't the one under test.
 *
 * @see components/resparkable/workspace/tabs/areas-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AreasTab } from '@/components/resparkable/workspace/tabs/areas-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/areas/areas-view', () => ({
  AreasView: (props: Record<string, unknown>) => (
    <div data-testid="areas-view">{JSON.stringify(props)}</div>
  ),
}));

function area(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'area_1',
    name: 'Health',
    slug: 'health',
    description: null,
    colour: '#ff0000',
    sortOrder: 0,
    archivedAt: null,
    archivedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('AreasTab', () => {
  it('requests the areas collection with a 200 limit', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<AreasTab />);

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.AREAS}?limit=200`)
    );
  });

  it('shows a labelled loading state before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<AreasTab />);

    expect(screen.getByText('Loading life areas')).toBeInTheDocument();
  });

  it('renders TabLoadError with the API error message and retries through the hook', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Areas are unavailable.', 'ERR', 500)
    );

    render(<AreasTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Areas are unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your life areas/)).toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue([area()]);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('areas-view')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('passes exactly the validated data through to AreasView, not the raw response', async () => {
    const rawWithExtraField = [{ ...area(), unexpectedField: 'should be dropped by nothing here' }];
    vi.mocked(apiClient.get).mockResolvedValue(rawWithExtraField);

    render(<AreasTab />);

    await waitFor(() => expect(screen.getByTestId('areas-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('areas-view').textContent ?? '{}');
    expect(rendered.areas).toEqual([area()]);
  });

  it('renders an empty AreasView when the fetch resolves with no areas', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<AreasTab />);

    await waitFor(() => expect(screen.getByTestId('areas-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('areas-view').textContent ?? '{}');
    expect(rendered.areas).toEqual([]);
  });
});
