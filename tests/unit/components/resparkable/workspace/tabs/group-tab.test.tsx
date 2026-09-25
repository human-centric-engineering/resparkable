// @vitest-environment happy-dom

/**
 * Unit Tests: GroupTab.
 *
 * Three independent `useTabFetch` calls sharing one `apiClient.get` mock,
 * distinguished by endpoint: the group detail (drives loading/error), the
 * budget (a soft dependency: `null` until it resolves, matching what
 * `GroupDetail` expects), and the invites, which the tab's own header
 * comment says is admin-only at the route, so it must not even be
 * requested for a non-admin, not merely hidden once it comes back 403.
 *
 * `GroupDetail` is mocked to a marker so this file is only about which props
 * GroupTab computes for it, not that component's own rendering.
 *
 * @see components/resparkable/workspace/tabs/group-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

const mockUseSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({
  useSession: () => mockUseSession(),
}));

vi.mock('@/components/resparkable/groups/group-detail', () => ({
  GroupDetail: (props: Record<string, unknown>) => (
    <div data-testid="group-detail">{JSON.stringify(props)}</div>
  ),
}));

import { GroupTab } from '@/components/resparkable/workspace/tabs/group-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type {
  GroupBudgetWire,
  GroupDetailWire,
  GroupInviteWire,
} from '@/lib/framework/resparkable/ui/payloads';

const GROUP_ID = 'group_1';
const DETAIL_ENDPOINT = RESPARKABLE_API.group(GROUP_ID);
const BUDGET_ENDPOINT = RESPARKABLE_API.groupBudget(GROUP_ID);
const INVITES_ENDPOINT = RESPARKABLE_API.groupInvites(GROUP_ID);

function detailFixture(overrides: Partial<GroupDetailWire> = {}): GroupDetailWire {
  return {
    group: {
      groupId: GROUP_ID,
      name: 'Study Group',
      slug: 'study-group',
      description: null,
      spaceId: 'grp_space_1',
      maxMembers: 50,
      viewersCanInheritAdmin: true,
    },
    yourRole: 'member',
    members: [],
    latestDigest: null,
    ...overrides,
  };
}

function budgetFixture(overrides: Partial<GroupBudgetWire> = {}): GroupBudgetWire {
  return {
    balanceCredits: 40,
    fundingMode: 'self_funded',
    canTopUp: true,
    yourPersonalBalanceCredits: 10,
    you: { dailyCreditCap: null, spentLastDayCredits: 0 },
    admin: null,
    ...overrides,
  };
}

const INVITES: GroupInviteWire[] = [
  {
    id: 'invite_1',
    email: 'friend@example.com',
    role: 'member',
    invitedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    acceptedAt: null,
  },
];

/** Never-resolving promise, for pinning a fetch in its loading state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function mockGet(responses: Record<string, unknown>) {
  vi.mocked(apiClient.get).mockImplementation((endpoint: string) => {
    if (!(endpoint in responses)) return pending();
    const entry = responses[endpoint];
    return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
  });
}

function propsOf(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('group-detail').textContent ?? '{}');
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  mockUseSession.mockReturnValue({ data: { user: { id: 'user_a' } }, isPending: false });
});

describe('GroupTab', () => {
  it('shows a loading skeleton while the detail fetch is pending', () => {
    mockGet({});

    render(<GroupTab id={GROUP_ID} />);

    expect(screen.getByText('Loading this group')).toBeInTheDocument();
  });

  it('shows a load error and retries only the detail fetch', async () => {
    mockGet({
      [DETAIL_ENDPOINT]: new APIClientError('Server is down.', 'ERR', 500),
      [BUDGET_ENDPOINT]: budgetFixture(),
    });
    const user = userEvent.setup();

    render(<GroupTab id={GROUP_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load this group.');

    vi.mocked(apiClient.get).mockReset();
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture(),
      [BUDGET_ENDPOINT]: budgetFixture(),
    });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('group-detail')).toBeInTheDocument();
  });

  it('renders GroupDetail with the budget once it has loaded', async () => {
    const budget = budgetFixture({ balanceCredits: 77 });
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture(),
      [BUDGET_ENDPOINT]: budget,
    });

    render(<GroupTab id={GROUP_ID} />);

    expect(await screen.findByTestId('group-detail')).toBeInTheDocument();
    expect(propsOf().budget).toEqual(budget);
  });

  it('passes budget: null while the budget fetch has not resolved yet', async () => {
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture(),
      // BUDGET_ENDPOINT deliberately absent: `mockGet` leaves it pending.
    });

    render(<GroupTab id={GROUP_ID} />);

    expect(await screen.findByTestId('group-detail')).toBeInTheDocument();
    expect(propsOf().budget).toBeNull();
  });

  it('fetches the invites only for an admin', async () => {
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture({ yourRole: 'admin' }),
      [BUDGET_ENDPOINT]: budgetFixture(),
      [INVITES_ENDPOINT]: INVITES,
    });

    render(<GroupTab id={GROUP_ID} />);

    await screen.findByTestId('group-detail');
    await waitFor(() => expect(propsOf().invites).toEqual(INVITES));
    expect(apiClient.get).toHaveBeenCalledWith(INVITES_ENDPOINT);
  });

  it('never fetches the invites for a non-admin', async () => {
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture({ yourRole: 'member' }),
      [BUDGET_ENDPOINT]: budgetFixture(),
    });

    render(<GroupTab id={GROUP_ID} />);

    expect(await screen.findByTestId('group-detail')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalledWith(INVITES_ENDPOINT);
    expect(propsOf().invites).toEqual([]);
  });

  it('reads the viewer id from the cached session, not a second request', async () => {
    mockUseSession.mockReturnValue({ data: { user: { id: 'user_z' } }, isPending: false });
    mockGet({
      [DETAIL_ENDPOINT]: detailFixture(),
      [BUDGET_ENDPOINT]: budgetFixture(),
    });

    render(<GroupTab id={GROUP_ID} />);

    expect(await screen.findByTestId('group-detail')).toBeInTheDocument();
    expect(propsOf().viewerUserId).toBe('user_z');
  });
});
