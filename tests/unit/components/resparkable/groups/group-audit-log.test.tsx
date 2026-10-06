// @vitest-environment happy-dom

/**
 * Component Tests: the admin record on the group page (phase 58, §23.13).
 *
 * @see components/resparkable/groups/group-audit-log.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { GroupAuditLog } from '@/components/resparkable/groups/group-audit-log';
import { apiClient } from '@/lib/api/client';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    action: 'role_changed',
    actorName: 'Sam',
    subjectName: 'Priya',
    aboutYou: false,
    byYou: false,
    metadata: { from: 'member', to: 'viewer' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupAuditLog', () => {
  it('shows an admin the whole record, under its own heading', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([entry()]);
    render(<GroupAuditLog groupId="grp_1" isAdmin />);

    expect(screen.getByRole('heading', { name: /Admin record/ })).toBeInTheDocument();
    expect(await screen.findByText('Sam made Priya a viewer')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1/audit');
  });

  it('shows a member what was done to them, under a heading that says so', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([entry({ aboutYou: true, subjectName: null })]);
    render(<GroupAuditLog groupId="grp_1" isAdmin={false} />);

    expect(await screen.findByText('Sam made you a viewer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Changes to your membership/ })).toBeInTheDocument();
  });

  it('shows a member with nothing done to them nothing at all', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);
    const { container } = render(<GroupAuditLog groupId="grp_1" isAdmin={false} />);

    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('tells an admin when nothing has been changed yet', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);
    render(<GroupAuditLog groupId="grp_1" isAdmin />);

    expect(await screen.findByText('Nothing has been changed yet.')).toBeInTheDocument();
  });

  it('drops an entry it cannot word rather than showing an internal name', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([
      entry({ id: 'x', action: 'something_new' }),
      entry(),
    ]);
    render(<GroupAuditLog groupId="grp_1" isAdmin />);

    expect(await screen.findByText('Sam made Priya a viewer')).toBeInTheDocument();
    expect(screen.queryByText(/something_new/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('says so when the record cannot be loaded', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('down'));
    render(<GroupAuditLog groupId="grp_1" isAdmin />);

    expect(await screen.findByText('The record could not be loaded.')).toBeInTheDocument();
  });

  it('treats a malformed payload as a failure to load', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ not: 'a list' });
    render(<GroupAuditLog groupId="grp_1" isAdmin />);

    expect(await screen.findByText('The record could not be loaded.')).toBeInTheDocument();
  });
});
