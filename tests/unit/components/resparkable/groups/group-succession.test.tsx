// @vitest-environment happy-dom

/**
 * GroupSuccession Component Tests.
 *
 * What an admin is told about the role outliving them, and the one setting
 * that changes it. What has to hold:
 *
 *   1. **Only the sole admin sees the notice**, and it names who would inherit
 *      today by running the same rule erasure runs.
 *   2. **The notice follows the setting.** Turning viewers off changes the
 *      named successor, or says nobody, before the save returns.
 *   3. **A failed save rolls the switch back**, or the page would claim a
 *      setting the server does not have.
 *
 * @see components/resparkable/groups/group-succession.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { GroupSuccession } from '@/components/resparkable/groups/group-succession';
import { apiClient } from '@/lib/api/client';

const AT = (day: number) => `2026-09-0${day}T10:00:00.000Z`;

const ADMIN = { userId: 'user_a', role: 'admin', joinedAt: AT(1), requestedAt: null };
const VIEWER = { userId: 'user_v', role: 'viewer', joinedAt: AT(2), requestedAt: null };
const MEMBER = { userId: 'user_m', role: 'member', joinedAt: AT(3), requestedAt: null };

function renderSuccession(
  members: Array<{
    userId: string;
    role: string;
    joinedAt: string | null;
    requestedAt: string | null;
  }>,
  viewersCanInheritAdmin = true
) {
  return render(
    <GroupSuccession
      groupId="grp_1"
      members={members}
      viewerUserId="user_a"
      viewersCanInheritAdmin={viewersCanInheritAdmin}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupSuccession', () => {
  it('tells a sole admin that the longest-standing member inherits, even a viewer', () => {
    renderSuccession([ADMIN, VIEWER, MEMBER]);

    expect(screen.getByText(/user_v will become admin/)).toBeInTheDocument();
    expect(screen.getByText(/even though they are a viewer/)).toBeInTheDocument();
  });

  it('names the first non-viewer when viewers are excluded', () => {
    renderSuccession([ADMIN, VIEWER, MEMBER], false);

    expect(screen.getByText(/user_m will become admin/)).toBeInTheDocument();
    expect(screen.queryByText(/even though they are a viewer/)).not.toBeInTheDocument();
  });

  it('says nobody would become admin when only viewers are left and they are excluded', () => {
    renderSuccession([ADMIN, VIEWER], false);

    expect(screen.getByText(/nobody will become admin/)).toBeInTheDocument();
  });

  it('tells a lone member the group would be deleted', () => {
    renderSuccession([ADMIN]);

    expect(screen.getByText(/this group and everything in it will be deleted/)).toBeInTheDocument();
  });

  it('shows no notice while another admin is there', () => {
    renderSuccession([ADMIN, { ...MEMBER, role: 'admin' }]);

    expect(screen.queryByText(/You are the only/)).not.toBeInTheDocument();
    // The setting is still offered: it matters the day either admin leaves.
    expect(screen.getByRole('switch', { name: 'A viewer can become admin' })).toBeInTheDocument();
  });

  it('does not count a pending admin row as a second admin', () => {
    renderSuccession([
      ADMIN,
      { userId: 'user_p', role: 'admin', joinedAt: null, requestedAt: '2026-09-05T10:00:00.000Z' },
      VIEWER,
    ]);

    expect(screen.getByText(/You are the only admin/)).toBeInTheDocument();
  });

  it('saves the setting and updates the notice straight away', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ groupId: 'grp_1' });
    renderSuccession([ADMIN, VIEWER]);

    await user.click(screen.getByRole('switch', { name: 'A viewer can become admin' }));

    expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1', {
      body: { viewersCanInheritAdmin: false },
    });
    expect(await screen.findByText(/nobody will become admin/)).toBeInTheDocument();
  });

  it('rolls the switch back when the save fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('Only an admin can change this'));
    renderSuccession([ADMIN, VIEWER]);

    const toggle = screen.getByRole('switch', { name: 'A viewer can become admin' });
    await user.click(toggle);

    expect(await screen.findByText(/user_v will become admin/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});
