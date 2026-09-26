// @vitest-environment happy-dom

/**
 * Unit Tests: GroupsTab.
 *
 * One `useTabFetch` call, which drives the loading/error states, plus the
 * cached session for `viewerUserId`: the same split `GroupTab` makes, and
 * for the same reason. A tab has no server props to pass it, so it reads the
 * browser's own cached session rather than asking again.
 *
 * `GroupsView` is mocked to a props-dumping marker so this file is only
 * about which props `GroupsTab` computes for it, not that component's own
 * rendering.
 *
 * @see components/resparkable/workspace/tabs/groups-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

const mockUseSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({
  useSession: () => mockUseSession(),
}));

vi.mock('@/components/resparkable/groups/groups-view', () => ({
  GroupsView: (props: Record<string, unknown>) => (
    <div data-testid="groups-view">{JSON.stringify(props)}</div>
  ),
}));

import { GroupsTab } from '@/components/resparkable/workspace/tabs/groups-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupListItemWire } from '@/lib/framework/resparkable/ui/payloads';

const GROUPS: GroupListItemWire[] = [
  {
    groupId: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: 'Thursday evenings',
    spaceId: 'spc_group_1',
    role: 'member',
    joinedAt: '2026-09-01T10:00:00.000Z',
  },
];

function propsOf(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('groups-view').textContent ?? '{}');
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  mockUseSession.mockReturnValue({ data: { user: { id: 'user_a' } }, isPending: false });
});

describe('GroupsTab', () => {
  it('shows a loading skeleton while the fetch is pending', () => {
    // Never resolves, so the hook stays in its loading state.
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<GroupsTab />);

    expect(screen.getByText('Loading your groups')).toBeInTheDocument();
  });

  it('shows a load error and retries the fetch', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(
      new APIClientError('Server is down.', 'ERR', 500)
    );
    const user = userEvent.setup();

    render(<GroupsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your groups.');

    vi.mocked(apiClient.get).mockResolvedValueOnce(GROUPS);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('groups-view')).toBeInTheDocument();
  });

  it('renders GroupsView with the fetched list and the cached session as viewerUserId', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce(GROUPS);

    render(<GroupsTab />);

    expect(await screen.findByTestId('groups-view')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith(RESPARKABLE_API.GROUPS);
    expect(propsOf().initial).toEqual(GROUPS);
    expect(propsOf().viewerUserId).toBe('user_a');
  });

  it('reads the viewer id from the cached session, not a second request', async () => {
    mockUseSession.mockReturnValue({ data: { user: { id: 'user_z' } }, isPending: false });
    vi.mocked(apiClient.get).mockResolvedValueOnce(GROUPS);

    render(<GroupsTab />);

    expect(await screen.findByTestId('groups-view')).toBeInTheDocument();
    expect(propsOf().viewerUserId).toBe('user_z');
  });

  it('passes an empty string for viewerUserId when there is no cached session', async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false });
    vi.mocked(apiClient.get).mockResolvedValueOnce(GROUPS);

    render(<GroupsTab />);

    expect(await screen.findByTestId('groups-view')).toBeInTheDocument();
    expect(propsOf().viewerUserId).toBe('');
  });
});
