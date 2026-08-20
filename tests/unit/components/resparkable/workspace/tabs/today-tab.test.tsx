/**
 * Unit Tests: TodayTab.
 *
 * `TodayTab` is the thinnest `useTabFetch` adapter — one fetch, one schema,
 * one view. `useTabFetch`'s own loading/error/ready transitions are already
 * pinned down in `use-tab-fetch.test.ts`; this file only proves TodayTab's
 * own wiring: which endpoint it calls, which copy it shows for each state,
 * and that the parsed payload actually reaches `TodayView` unmodified.
 *
 * `apiClient.get` is mocked (the hook's real fetch-then-validate logic still
 * runs against `todayPayloadSchema`), and `TodayView` is mocked to a marker
 * so this file isn't also re-testing that component's own rendering.
 *
 * @see components/resparkable/workspace/tabs/today-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TodayTab } from '@/components/resparkable/workspace/tabs/today-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { TodayPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/today/today-view', () => ({
  TodayView: ({ payload }: { payload: TodayPayloadWire }) => (
    <div data-testid="today-view">{JSON.stringify(payload)}</div>
  ),
}));

const validPayload: TodayPayloadWire = {
  generatedAt: '2026-08-01T00:00:00.000Z',
  timezone: 'UTC',
  tasks: [],
  returnedFromSnooze: [],
  timeBlocks: [],
  inboxCount: 3,
  openTaskCount: 5,
  goalsAtRisk: [],
  unreviewedLinks: { count: 0, items: [] },
  latestReview: null,
  briefing: { review: null, stale: false, ageHours: null },
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('TodayTab', () => {
  it('fetches the TODAY endpoint and shows a loading skeleton first', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {})); // never resolves

    render(<TodayTab />);

    expect(screen.getByText('Loading today')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(RESPARKABLE_API.TODAY);
  });

  it('renders TabLoadError with the "your day" label when the fetch fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server unwell.', 'ERR', 500));

    render(<TodayTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load your day/)).toBeInTheDocument();
    expect(screen.getByText('Server unwell.')).toBeInTheDocument();
  });

  it('retries the same endpoint and recovers into the ready view', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(new APIClientError('First try failed.', 'ERR', 500))
      .mockResolvedValueOnce(validPayload);

    render(<TodayTab />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('today-view')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('renders TodayView with the parsed payload once the fetch resolves', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(validPayload);

    render(<TodayTab />);

    await waitFor(() => expect(screen.getByTestId('today-view')).toBeInTheDocument());
    expect(screen.getByTestId('today-view')).toHaveTextContent('"inboxCount":3');
    expect(screen.getByTestId('today-view')).toHaveTextContent('"openTaskCount":5');
  });
});
