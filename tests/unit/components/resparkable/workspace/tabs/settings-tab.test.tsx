// @vitest-environment happy-dom

/**
 * Unit Tests: SettingsTab.
 *
 * Same shape as `TodayTab` — one `useTabFetch` call against `RESPARKABLE_API.SPACE`
 * with a schema defined locally in the tab (there's no shared `settingsSchema`
 * export, per this file's own header comment). `SpaceSettingsForm` is mocked to a
 * marker so this file stays about SettingsTab's own state wiring, not the form's
 * internals (covered by `space-settings-form.test.tsx`).
 *
 * @see components/resparkable/workspace/tabs/settings-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsTab } from '@/components/resparkable/workspace/tabs/settings-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/settings/space-settings-form', () => ({
  SpaceSettingsForm: ({ initial }: { initial: Record<string, unknown> }) => (
    <div data-testid="settings-form">{JSON.stringify(initial)}</div>
  ),
}));

const validSettings = {
  timezone: 'America/New_York',
  workStyle: 'deep-work',
  priorityWeights: { urgency: 0.5, importance: 0.5 },
  connectionStrengthFloor: 0.55,
  retentionPolicy: { thought: 90 },
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('SettingsTab', () => {
  it('fetches the SPACE endpoint and shows a loading skeleton first', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<SettingsTab />);

    expect(screen.getByText('Loading settings')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(RESPARKABLE_API.SPACE);
  });

  it('renders TabLoadError with the "your settings" label when the fetch fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server unwell.', 'ERR', 500));

    render(<SettingsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load your settings/)).toBeInTheDocument();
  });

  it('retries the same endpoint after a failure', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(new APIClientError('First try failed.', 'ERR', 500))
      .mockResolvedValueOnce(validSettings);

    render(<SettingsTab />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('renders the timezone explainer copy and passes the parsed settings to the form', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(validSettings);

    render(<SettingsTab />);

    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    expect(screen.getByText(/resolves in the timezone below/)).toBeInTheDocument();
    expect(screen.getByTestId('settings-form')).toHaveTextContent('America/New_York');
    expect(screen.getByTestId('settings-form')).toHaveTextContent('"connectionStrengthFloor":0.55');
  });

  it('reports a shape mismatch as an error rather than crashing', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ nope: true });

    render(<SettingsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('That response wasn’t what we expected.')).toBeInTheDocument();
  });
});
