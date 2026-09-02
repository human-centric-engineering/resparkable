// @vitest-environment happy-dom

/**
 * Unit Tests: `MySharesView` — the list that makes every share closable.
 *
 * The component's whole reason for existing is the row nothing else can show:
 * a live share on an item the owner can no longer open. So that is what the
 * tests are about, rather than the layout.
 *
 * - **A share whose item is gone renders, and can be revoked.** If this row
 *   were dropped for want of a title, the feature would not exist.
 * - **An archived item is flagged as still shared.** Archiving revokes nothing.
 * - **Revoking calls the existing DELETE routes**, per kind, with the share's
 *   own id. There is no second revoke endpoint and there must not be one.
 * - **A failed revoke puts the row back.** A share that looks closed and is not
 *   is the single failure this page must never produce.
 * - **The confirmation says what revoking actually does**, including that the
 *   item stops being public when the last link goes, because that consequence
 *   is invisible from the button.
 *
 * @see components/resparkable/share/my-shares-view.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { MySharesView } from '@/components/resparkable/share/my-shares-view';
import { apiClient } from '@/lib/api/client';
import type { MyShareItemWire } from '@/lib/framework/resparkable/ui/payloads';

const mockedDelete = vi.mocked(apiClient.delete);

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    entityType: 'project',
    entityId: 'proj_1',
    granteeEmail: 'friend@example.com',
    role: 'viewer',
    includeTaskDetail: false,
    accepted: true,
    invitedAt: null,
    expiresAt: null,
    revokedAt: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    entityType: 'review',
    entityId: 'rev_1',
    tokenPrefix: 'abcd',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    active: true,
    viewCount: 3,
    lastViewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function item(overrides: Partial<MyShareItemWire> = {}): MyShareItemWire {
  return {
    entityType: 'project',
    entityId: 'proj_1',
    title: 'Q4 launch',
    archived: false,
    grants: [grant()],
    links: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDelete.mockResolvedValue(undefined);
});

describe('MySharesView', () => {
  it('renders a share whose item no longer exists, and offers the revoke', () => {
    render(
      <MySharesView
        items={[item({ entityType: 'review', entityId: 'rev_1', title: null, links: [link()] })]}
      />
    );

    // The row the whole surface exists for: before this page, a live link here
    // could not be reached by anything.
    expect(screen.getByText('This item no longer exists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revoke Public link abcd/ })).toBeInTheDocument();
  });

  it('flags an archived item as still shared', () => {
    render(<MySharesView items={[item({ archived: true })]} />);

    expect(screen.getByText('archived')).toBeInTheDocument();
    // Archiving revokes nothing. Saying so is the point.
    expect(screen.getByText('still shared')).toBeInTheDocument();
  });

  it('counts the items the owner cannot open', () => {
    render(
      <MySharesView
        items={[
          item(),
          item({ entityId: 'proj_2', title: 'Old', archived: true }),
          item({ entityId: 'proj_3', title: null }),
        ]}
      />
    );

    expect(screen.getByText(/2 on items you can no longer open/)).toBeInTheDocument();
  });

  it('revokes a grant through the existing grant route', async () => {
    const user = userEvent.setup();
    render(<MySharesView items={[item()]} />);

    await user.click(screen.getByRole('button', { name: /Revoke friend@example.com/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/grants/grant_1');
    });
    // The row goes, and with its only share gone so does the item.
    await waitFor(() => {
      expect(screen.queryByText('Q4 launch')).toBeNull();
    });
  });

  it('revokes a link through the existing share-link route', async () => {
    const user = userEvent.setup();
    render(
      <MySharesView
        items={[
          item({
            entityType: 'review',
            entityId: 'rev_1',
            title: 'Tuesday',
            grants: [],
            links: [link()],
          }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Revoke Public link abcd/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/share-links/link_1');
    });
  });

  it('puts the share back when the revoke fails', async () => {
    const user = userEvent.setup();
    mockedDelete.mockRejectedValue(new Error('nope'));
    render(<MySharesView items={[item()]} />);

    await user.click(screen.getByRole('button', { name: /Revoke friend@example.com/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    // A share that looks closed and is not is the one outcome this page must
    // never produce, so the optimistic removal rolls back.
    await waitFor(() => {
      expect(screen.getByText('friend@example.com')).toBeInTheDocument();
    });
  });

  it('says what revoking a link actually does, including the visibility flip', async () => {
    const user = userEvent.setup();
    render(<MySharesView items={[item({ grants: [], links: [link()] })]} />);

    await user.click(screen.getByRole('button', { name: /Revoke Public link abcd/ }));

    // The consequence that is invisible from the button: the last live link
    // going takes the item's `visibility` back to private with it.
    expect(screen.getByText(/the item stops being public as well/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be switched back on/)).toBeInTheDocument();
  });

  it('reads as an invitation rather than an error when nothing is shared', () => {
    render(<MySharesView items={[]} />);

    expect(screen.getByText('You have not shared anything')).toBeInTheDocument();
  });
});
