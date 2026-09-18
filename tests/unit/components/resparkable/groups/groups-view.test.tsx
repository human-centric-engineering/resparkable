// @vitest-environment happy-dom

/**
 * GroupsView Component Tests (phase 47).
 *
 * The behaviour that would look fine if it were wrong:
 *
 *   1. **"Open" carries the workspace in the URL**, because that is the whole
 *      of what opening a group means. A link without `?space=` would land on
 *      the reader's own Today page, look completely normal, and be the wrong
 *      brain.
 *   2. **A pending membership is shown and cannot be opened.** §23.11: somebody
 *      who asked to join should see that they asked, and clicking through to a
 *      workspace they have not been let into would 404.
 *   3. **The copy says a group workspace starts empty**, before somebody
 *      invites four people expecting to find their own projects in it.
 *
 * @see components/resparkable/groups/groups-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { GroupsView } from '@/components/resparkable/groups/groups-view';
import { apiClient } from '@/lib/api/client';

const JOINED = {
  groupId: 'grp_1',
  name: 'Study Group B',
  slug: 'study-group-b',
  description: 'Thursday evenings',
  spaceId: 'spc_group_1',
  role: 'member',
  joinedAt: '2026-09-01T10:00:00.000Z',
};

const PENDING = { ...JOINED, groupId: 'grp_2', name: 'Allotment', joinedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupsView', () => {
  it('opens a group by naming its workspace in the URL', () => {
    render(<GroupsView initial={[JOINED]} />);

    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/resparkable?space=spc_group_1'
    );
  });

  it('shows a pending membership as waiting, with no way in', () => {
    render(<GroupsView initial={[PENDING]} />);

    expect(screen.getByText(/waiting to be let in/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('says the workspace starts empty before anyone invites people into it', () => {
    render(<GroupsView initial={[]} />);

    expect(screen.getByText(/Nothing from yours moves into it/)).toBeInTheDocument();
  });

  it('adds the created group to the list without a second fetch', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      groupId: 'grp_new',
      name: 'Book Club',
      slug: 'book-club',
      spaceId: 'spc_new',
      role: 'admin',
    });

    render(<GroupsView initial={[]} />);
    await user.type(screen.getByLabelText('Start a group'), 'Book Club');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/groups', {
      body: { name: 'Book Club' },
    });
    // The POST already said what was created. Refetching would be a round trip
    // to be told it again.
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('leaves the box alone when creating fails, so the name is not lost', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(new Error('offline'));

    render(<GroupsView initial={[]} />);
    await user.type(screen.getByLabelText('Start a group'), 'Book Club');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    expect(await screen.findByDisplayValue('Book Club')).toBeInTheDocument();
  });

  it('does not carry the workspace on the management routes', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      groupId: 'g',
      name: 'x',
      slug: 'x',
      spaceId: 's',
      role: 'admin',
    });

    render(<GroupsView initial={[]} />);
    await user.type(screen.getByLabelText('Start a group'), 'x');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    // These routes are keyed on the actor, not on a workspace, and read no
    // `?space=`. Appending one would imply a relationship that is not there.
    expect(vi.mocked(apiClient.post).mock.calls[0]?.[0]).not.toContain('space=');
  });
});
