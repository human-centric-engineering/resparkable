// @vitest-environment happy-dom

/**
 * Component Tests: the group's document storage on the group page (phase 58).
 *
 * @see components/resparkable/groups/group-storage.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { GroupStorage } from '@/components/resparkable/groups/group-storage';
import { apiClient } from '@/lib/api/client';

const GB = 1024 * 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupStorage', () => {
  it('tells every member how much of the shelf is used', () => {
    render(<GroupStorage groupId="grp_1" isAdmin={false} usedBytes={GB / 2} quotaBytes={2 * GB} />);

    expect(screen.getByText('512 MB of 2 GB used.')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('lets an admin raise the limit, sent in bytes', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ groupId: 'grp_1' });
    const user = userEvent.setup();
    render(<GroupStorage groupId="grp_1" isAdmin usedBytes={0} quotaBytes={2 * GB} />);

    const input = screen.getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1', {
        body: { storageQuotaBytes: 5 * GB },
      });
    });
    expect(await screen.findByText('0 MB of 5 GB used.')).toBeInTheDocument();
  });

  it('puts the old limit back when the save is refused', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('Too large'));
    const user = userEvent.setup();
    render(<GroupStorage groupId="grp_1" isAdmin usedBytes={0} quotaBytes={2 * GB} />);

    const input = screen.getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '5000');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByDisplayValue('2')).toBeInTheDocument();
  });
});
