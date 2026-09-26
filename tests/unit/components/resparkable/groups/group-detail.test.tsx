// @vitest-environment happy-dom

/**
 * GroupDetail Component Tests (phase 47).
 *
 * Membership is write access to an entire brain, so the assertions are about
 * the moments that change it:
 *
 *   1. **An invitation grants nothing until it is accepted**, and the copy says
 *      so. That sentence is the only thing on screen explaining why invitations
 *      and members are two separate lists.
 *   2. **Every mutation rolls back.** The service refuses demoting or removing
 *      the last admin, and a UI that showed the change anyway would tell
 *      somebody they had left a group they are still in.
 *   3. **A non-admin is offered nothing they cannot do.** The routes refuse
 *      them; a form that produced a 403 would be a worse way to find that out.
 *   4. **Leaving navigates away and refreshes**, because the page you are on
 *      stops being yours to look at and the header switcher still lists the
 *      workspace until the server renders again.
 *   5. **A request to join is not a member.** A row with `joinedAt: null` is
 *      shown to admins in its own list, never in the member list or its
 *      count, and answering it rolls back on a refusal the same as any other
 *      mutation here.
 *
 * @see components/resparkable/groups/group-detail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import type { GroupDetailWire, GroupJoinLinkWire } from '@/lib/framework/resparkable/ui/payloads';
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { apiClient } from '@/lib/api/client';

const push = vi.fn();
const refresh = vi.fn();

const DETAIL: GroupDetailWire = {
  group: {
    groupId: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: 'Thursday evenings',
    spaceId: 'spc_group_1',
    maxMembers: 50,
    viewersCanInheritAdmin: true,
    joinRefusedFullAt: null,
  },
  yourRole: 'admin',
  latestDigest: null,
  members: [
    { userId: 'user_a', role: 'admin', joinedAt: '2026-09-01T10:00:00.000Z', requestedAt: null },
    { userId: 'user_b', role: 'member', joinedAt: '2026-09-02T10:00:00.000Z', requestedAt: null },
  ],
};

/** A request to join through a `request` link: no `joinedAt`, an admin's to answer. */
const PENDING = {
  userId: 'user_p',
  role: 'member',
  joinedAt: null,
  requestedAt: '2026-09-10T10:00:00.000Z',
  name: 'Pat Rivera',
};

const INVITE = {
  id: 'inv_1',
  email: 'them@example.com',
  role: 'member',
  invitedAt: '2026-09-02T10:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  acceptedAt: null,
};

function renderDetail(
  overrides: Partial<GroupDetailWire> = {},
  invites = [INVITE],
  joinLinks: GroupJoinLinkWire[] = []
) {
  return render(
    <GroupDetail
      detail={{ ...DETAIL, ...overrides }}
      invites={invites}
      joinLinks={joinLinks}
      budget={null}
      viewerUserId="user_a"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push, refresh } as never);
});

describe('GroupDetail', () => {
  it('says an invitation grants nothing until it is accepted', () => {
    renderDetail();

    // The sentence that makes two lists make sense instead of looking like a
    // duplicate.
    expect(screen.getByText(/gives no access until the person opens it/)).toBeInTheDocument();
  });

  it('sends an invitation with its address and role', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ inviteId: 'inv_2', sent: true });

    renderDetail();
    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: /Invite/ }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1/invites', {
      body: { email: 'new@example.com', role: 'member' },
    });
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
  });

  it('removes a withdrawn invitation at once and puts it back when that fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('offline'));

    renderDetail();
    await user.click(screen.getByRole('button', { name: /Withdraw the invitation/ }));

    // Optimistic, then honest. An invitation shown as withdrawn that is still
    // live is somebody being told they closed a door they left open.
    expect(await screen.findByText('them@example.com')).toBeInTheDocument();
  });

  it('rolls a role change back when the service refuses it', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('last_admin'));

    renderDetail();
    await user.click(screen.getByLabelText('Role for user_b'));
    await user.click(await screen.findByRole('option', { name: 'viewer' }));

    expect(apiClient.patch).toHaveBeenCalledWith(
      '/api/v1/resparkable/groups/grp_1/members/user_b',
      { body: { role: 'viewer' } }
    );
    // The last-admin rules live in the service, so the UI has to believe the
    // refusal rather than its own optimism.
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Role for user_b')).toHaveTextContent('member')
    );
  });

  it('navigates away and refreshes after you leave', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockResolvedValue(undefined);

    renderDetail();
    await user.click(screen.getByRole('button', { name: 'Leave this group' }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/resparkable/groups'));
    // Without the refresh the header switcher keeps offering a workspace that
    // now 404s on the click.
    expect(refresh).toHaveBeenCalled();
  });

  it('stays put when leaving fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('last_admin'));

    renderDetail();
    await user.click(screen.getByRole('button', { name: 'Leave this group' }));

    await vi.waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it('offers a member nothing an admin route would refuse them', () => {
    renderDetail({ yourRole: 'member' }, []);

    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Role for user_b')).not.toBeInTheDocument();
    // Leaving is still theirs to do.
    expect(screen.getByRole('button', { name: 'Leave this group' })).toBeInTheDocument();
  });

  it('shows the newest digest, and says so plainly when there is none yet', () => {
    const { unmount } = renderDetail({
      latestDigest: {
        id: 'review_1',
        title: 'Week of 14 September',
        body: 'Eleven tasks were finished.',
        generatedAt: '2026-09-21T08:00:00.000Z',
      },
    });
    expect(screen.getByText('Week of 14 September')).toBeInTheDocument();
    expect(screen.getByText('Eleven tasks were finished.')).toBeInTheDocument();
    unmount();

    renderDetail({ latestDigest: null });
    expect(screen.getByText(/No digest yet/)).toBeInTheDocument();
  });

  it('shows the credits panel when the budget loaded, with the admin half only for an admin', () => {
    const budget = {
      balanceCredits: 40,
      fundingMode: 'self_funded' as const,
      canTopUp: false,
      yourPersonalBalanceCredits: 5,
      you: { dailyCreditCap: null, spentLastDayCredits: 0 },
      admin: null,
    };
    const { unmount } = render(
      <GroupDetail
        detail={{ ...DETAIL, yourRole: 'member' }}
        invites={[]}
        joinLinks={[]}
        budget={budget}
        viewerUserId="user_a"
      />
    );
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.queryByText('Only admins see this part.')).toBeNull();
    unmount();

    render(
      <GroupDetail
        detail={DETAIL}
        invites={[]}
        joinLinks={[]}
        budget={{
          ...budget,
          canTopUp: true,
          admin: {
            lowBalanceAlertCredits: 10,
            largeRunAlertPercent: 50,
            windowDays: 30,
            members: [],
          },
        }}
        viewerUserId="user_a"
      />
    );
    expect(screen.getByText('Only admins see this part.')).toBeInTheDocument();
  });

  it('names members by id and never by address', () => {
    renderDetail();

    // Every member can see who else is in the group, which §23.4 makes
    // unavoidable. Handing out everybody's email is a separate decision nobody
    // made, and the member route does not return one.
    expect(screen.getByText('user_b')).toBeInTheDocument();
    expect(screen.queryByText(/user_b@/)).not.toBeInTheDocument();
  });

  it('shows an admin an "Asking to join" list for a pending member, named by account name', () => {
    renderDetail({ members: [...DETAIL.members, PENDING] });

    expect(screen.getByRole('heading', { name: 'Asking to join (1)' })).toBeInTheDocument();
    // The account name, never the raw id: admins decide who to let in by
    // name, not by a string that means nothing to them.
    expect(screen.getByText('Pat Rivera')).toBeInTheDocument();
    expect(screen.queryByText('user_p')).not.toBeInTheDocument();
  });

  it('falls back to "An account with no name" for a pending row whose account has none', () => {
    renderDetail({ members: [...DETAIL.members, { ...PENDING, name: null }] });

    expect(screen.getByText('An account with no name')).toBeInTheDocument();
  });

  it('explains a request in plain words, naming the click and the admin step', () => {
    renderDetail({ members: [...DETAIL.members, PENDING] });

    expect(
      screen.getByText(
        'They clicked a join link that needs an admin to let them in. They cannot see anything in the group until you do.'
      )
    ).toBeInTheDocument();
  });

  it('excludes a pending row from the Members list and its "N of M" count', () => {
    renderDetail({ members: [...DETAIL.members, PENDING] });

    // Two joined members, not three: the count is written against
    // `maxMembers`, and a request that resolves to no scope must not count
    // toward the cap it has not yet been let past.
    expect(screen.getByText('Members (2 of 50)')).toBeInTheDocument();
    // The member-limit form now sits between the heading and the list, so the
    // list is found within the section rather than assumed to be the
    // heading's very next sibling.
    const heading = screen.getByRole('heading', { name: 'Members (2 of 50)' });
    const membersList = heading.closest('section')?.querySelector('ul') ?? null;
    expect(membersList).not.toBeNull();
    expect(membersList && Array.from(membersList.querySelectorAll('li')).length).toBe(2);
  });

  it('lets an admin approve a request, which POSTs the join-request endpoint', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue(undefined);

    renderDetail({ members: [...DETAIL.members, PENDING] });
    await user.click(screen.getByRole('button', { name: 'Let in' }));

    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/v1/resparkable/groups/grp_1/join-requests/user_p'
    );
    // Approved: it moves off the requests list and into Members.
    expect(screen.queryByRole('heading', { name: /Asking to join/ })).not.toBeInTheDocument();
    expect(screen.getByText('Members (3 of 50)')).toBeInTheDocument();
  });

  it('lets an admin turn a request down, which DELETEs the join-request endpoint', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockResolvedValue(undefined);

    renderDetail({ members: [...DETAIL.members, PENDING] });
    await user.click(screen.getByRole('button', { name: 'Turn down Pat Rivera' }));

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/api/v1/resparkable/groups/grp_1/join-requests/user_p'
    );
    expect(screen.queryByText('Pat Rivera')).not.toBeInTheDocument();
  });

  it('labels the turn-down button "Turn down this request" when the account has no name', () => {
    renderDetail({ members: [...DETAIL.members, { ...PENDING, name: null }] });

    expect(screen.getByRole('button', { name: 'Turn down this request' })).toBeInTheDocument();
  });

  it('rolls a refused approval back to pending, rather than showing it as joined', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(new Error('group_full'));

    renderDetail({ members: [...DETAIL.members, PENDING] });
    await user.click(screen.getByRole('button', { name: 'Let in' }));

    // A full group refuses the approval; showing it as joined anyway would
    // tell the admin they let someone in when they did not.
    await vi.waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Asking to join (1)' })).toBeInTheDocument()
    );
    expect(screen.getByText('Members (2 of 50)')).toBeInTheDocument();
  });

  it('shows a non-admin no requests section at all', () => {
    renderDetail({ yourRole: 'member', members: [...DETAIL.members, PENDING] }, []);

    expect(screen.queryByRole('heading', { name: /Asking to join/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Pat Rivera')).not.toBeInTheDocument();
  });

  it('shows the full-group notice to an admin when joinRefusedFullAt is set and the group is full', () => {
    // DETAIL has two joined members, so a cap of 2 is actually full.
    renderDetail({
      group: { ...DETAIL.group, maxMembers: 2, joinRefusedFullAt: '2026-09-15T10:00:00.000Z' },
    });

    expect(
      screen.getByText(/Somebody was turned away because the group is full/)
    ).toBeInTheDocument();
  });

  it('hides the full-group notice once there is room, even though joinRefusedFullAt is still set', () => {
    // The server does not clear `joinRefusedFullAt` just because someone
    // later left or the cap was raised: the notice's own condition is what
    // has to make it disappear.
    renderDetail({
      group: { ...DETAIL.group, maxMembers: 50, joinRefusedFullAt: '2026-09-15T10:00:00.000Z' },
    });

    expect(
      screen.queryByText(/Somebody was turned away because the group is full/)
    ).not.toBeInTheDocument();
  });

  it('shows a non-admin no full-group notice, even when the group is genuinely full', () => {
    renderDetail(
      {
        yourRole: 'member',
        group: { ...DETAIL.group, maxMembers: 2, joinRefusedFullAt: '2026-09-15T10:00:00.000Z' },
      },
      []
    );

    expect(
      screen.queryByText(/Somebody was turned away because the group is full/)
    ).not.toBeInTheDocument();
  });

  it('shows no full-group notice to an admin when it is not set', () => {
    renderDetail();

    expect(
      screen.queryByText(/Somebody was turned away because the group is full/)
    ).not.toBeInTheDocument();
  });

  it('shows the member-limit form to an admin', () => {
    renderDetail();

    expect(document.getElementById('group-member-limit')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('offers no member-limit form to a non-admin', () => {
    renderDetail({ yourRole: 'member' }, []);

    expect(document.getElementById('group-member-limit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('disables Save while the draft equals the current limit, and enables it once changed', async () => {
    const user = userEvent.setup();
    renderDetail();

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    const input = document.getElementById('group-member-limit');
    if (!input) throw new Error('no #group-member-limit input');
    await user.clear(input);
    await user.type(input, '75');

    expect(saveButton).toBeEnabled();
  });

  it('PATCHes the group with the new member limit', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ groupId: 'grp_1' });
    renderDetail();

    const input = document.getElementById('group-member-limit');
    if (!input) throw new Error('no #group-member-limit input');
    await user.clear(input);
    await user.type(input, '75');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1', {
      body: { maxMembers: 75 },
    });
  });

  it('updates the "N of M" count and clears the full-group notice on a successful save', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ groupId: 'grp_1' });
    renderDetail({
      group: { ...DETAIL.group, maxMembers: 2, joinRefusedFullAt: '2026-09-15T10:00:00.000Z' },
    });
    expect(
      screen.getByText(/Somebody was turned away because the group is full/)
    ).toBeInTheDocument();

    const input = document.getElementById('group-member-limit');
    if (!input) throw new Error('no #group-member-limit input');
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Members (2 of 10)')).toBeInTheDocument();
    expect(
      screen.queryByText(/Somebody was turned away because the group is full/)
    ).not.toBeInTheDocument();
  });

  it('restores the draft input when the save fails, rather than showing an unsaved limit', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('not_an_admin'));
    renderDetail();

    const input = document.getElementById('group-member-limit') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '75');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(input.value).toBe('50'));
    // The count on screen never moved either: only the draft input changed.
    expect(screen.getByText('Members (2 of 50)')).toBeInTheDocument();
  });
});
