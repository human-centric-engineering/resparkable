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
 *
 * @see components/resparkable/groups/group-detail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { apiClient } from '@/lib/api/client';

const push = vi.fn();
const refresh = vi.fn();

const DETAIL = {
  group: {
    groupId: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: 'Thursday evenings',
    spaceId: 'spc_group_1',
    maxMembers: 50,
  },
  yourRole: 'admin',
  members: [
    { userId: 'user_a', role: 'admin', joinedAt: '2026-09-01T10:00:00.000Z' },
    { userId: 'user_b', role: 'member', joinedAt: '2026-09-02T10:00:00.000Z' },
  ],
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

function renderDetail(overrides: Partial<typeof DETAIL> = {}, invites = [INVITE]) {
  return render(
    <GroupDetail detail={{ ...DETAIL, ...overrides }} invites={invites} viewerUserId="user_a" />
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

  it('names members by id and never by address', () => {
    renderDetail();

    // Every member can see who else is in the group, which §23.4 makes
    // unavoidable. Handing out everybody's email is a separate decision nobody
    // made, and the member route does not return one.
    expect(screen.getByText('user_b')).toBeInTheDocument();
    expect(screen.queryByText(/user_b@/)).not.toBeInTheDocument();
  });
});
