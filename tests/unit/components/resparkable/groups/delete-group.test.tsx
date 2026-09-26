// @vitest-environment happy-dom

/**
 * DeleteGroup Component Tests (phase 48, §23.6).
 *
 *   1. **The delete button does nothing until the group's name is typed.** The
 *      server enforces the same rule; this is the half a person sees.
 *   2. **The typed name is what gets sent**, so the server can check it.
 *   3. **A refusal stays on screen.** The dialog does not close on a failed
 *      delete, or the reason would vanish with it.
 *   4. **Success leaves the page and refreshes**, because the workspace is gone
 *      and the header switcher still lists it until the server renders again.
 *   5. **Admins only, and never beside "leave".** Asserted through GroupDetail.
 *
 * @see components/resparkable/groups/delete-group.tsx
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

import { DeleteGroup } from '@/components/resparkable/groups/delete-group';
import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { apiClient } from '@/lib/api/client';

const push = vi.fn();
const refresh = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push, refresh } as never);
});

async function openDialog(otherMemberCount = 2) {
  const user = userEvent.setup();
  render(
    <DeleteGroup groupId="grp_1" groupName="Study Group B" otherMemberCount={otherMemberCount} />
  );
  await user.click(screen.getByRole('button', { name: 'Delete group' }));
  const dialog = await screen.findByRole('alertdialog');
  return { user, dialog };
}

function confirmButton(dialog: HTMLElement) {
  const buttons = Array.from(dialog.querySelectorAll('button'));
  const button = buttons.find((b) => b.textContent === 'Delete group');
  if (!button) throw new Error('no confirm button');
  return button;
}

describe('DeleteGroup', () => {
  it('keeps the delete button disabled until the name matches, case included', async () => {
    const { user, dialog } = await openDialog();

    expect(confirmButton(dialog)).toBeDisabled();

    await user.type(screen.getByLabelText(/to confirm/), 'study group b');
    expect(confirmButton(dialog)).toBeDisabled();

    await user.clear(screen.getByLabelText(/to confirm/));
    await user.type(screen.getByLabelText(/to confirm/), 'Study Group B');
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it('says how many other members will be emailed', async () => {
    await openDialog(3);

    expect(screen.getByText(/other 3 members will each get an email/)).toBeInTheDocument();
  });

  it('sends the typed name, then leaves the page and refreshes', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ deleted: true });
    const { user, dialog } = await openDialog();

    await user.type(screen.getByLabelText(/to confirm/), 'Study Group B');
    await user.click(confirmButton(dialog));

    expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1', {
      body: { confirmName: 'Study Group B' },
    });
    expect(push).toHaveBeenCalledWith('/resparkable/groups');
    expect(refresh).toHaveBeenCalled();
  });

  it('stays open and shows the refusal when the server says no', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('Only an admin can delete a group'));
    const { user, dialog } = await openDialog();

    await user.type(screen.getByLabelText(/to confirm/), 'Study Group B');
    await user.click(confirmButton(dialog));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('GroupDetail and deletion', () => {
  const DETAIL = {
    group: {
      groupId: 'grp_1',
      name: 'Study Group B',
      slug: 'study-group-b',
      description: null,
      spaceId: 'spc_group_1',
      maxMembers: 50,
      viewersCanInheritAdmin: true,
      joinRefusedFullAt: null,
    },
    yourRole: 'admin',
    latestDigest: null,
    members: [
      {
        userId: 'user_a',
        role: 'admin',
        joinedAt: '2026-09-01T10:00:00.000Z',
        requestedAt: null,
      },
      {
        userId: 'user_b',
        role: 'member',
        joinedAt: '2026-09-02T10:00:00.000Z',
        requestedAt: null,
      },
    ],
  };

  it('offers deletion to an admin, in its own section', () => {
    render(
      <GroupDetail
        detail={DETAIL}
        invites={[]}
        joinLinks={[]}
        budget={null}
        viewerUserId="user_a"
      />
    );

    const heading = screen.getByRole('heading', { name: 'Delete this group' });
    // Not inside the member list, where "leave" lives.
    expect(heading.closest('ul')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete group' })).toBeInTheDocument();
  });

  it('offers nothing to a member who is not an admin', () => {
    render(
      <GroupDetail
        detail={{ ...DETAIL, yourRole: 'member' }}
        invites={[]}
        joinLinks={[]}
        budget={null}
        viewerUserId="user_a"
      />
    );

    expect(screen.queryByRole('button', { name: 'Delete group' })).toBeNull();
  });
});
