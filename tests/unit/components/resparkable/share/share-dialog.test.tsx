// @vitest-environment happy-dom

/**
 * Unit Tests: `ShareDialog` — the owner's side of both kinds of sharing.
 *
 * Test coverage, per the component's own docblock and §13:
 * - Two tabs: People and Public link.
 * - People: submitting the form POSTs to `/grants` with the typed
 *   email/role/includeTaskDetail, THEN POSTs to `/grants/{id}/invite` — the
 *   grant is a database fact before it is a message, so both calls happen in
 *   that order.
 * - A failed invite send still reports the share as succeeded — access
 *   already exists either way.
 * - The grant list shows an "invited" badge only for an unaccepted grant.
 * - Revoke calls DELETE on `/grants/{id}` and reloads the list.
 * - Public link: minting shows the plaintext token exactly once, with
 *   "copy it now" wording.
 * - `filterBoard`, when present, renders the §13 dynamic-filter mitigation —
 *   the plain-English rule, the live count, and "Share a snapshot instead",
 *   which POSTs a snapshot and then shows the frozen message. Absent for an
 *   explicit board or a project, none of it renders.
 * - Groups tab (phase 49): lists the groups this workspace can share with and
 *   the existing group grants (grants whose `granteeGroup` is set), lets the
 *   owner grant a whole group with `granteeSpaceId` (never `granteeEmail`),
 *   shows member counts, and offers the same revoke as the People tab.
 *
 * @see components/resparkable/share/share-dialog.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Radix `Select` renders its dropdown through a portal happy-dom does not
// support, so it is mocked to a native `<select>` for the Groups tab tests
// that need to choose a target group: the same approach
// `account-export-panel.test.tsx` takes, and for the same reason. The goal is
// to prove this panel wires `onValueChange`, not to re-test Radix.
vi.mock('@/components/ui/select', () => {
  function SelectTrigger({ children }: { id?: string; children: React.ReactNode }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { ShareDialog, type ShareDialogProps } from '@/components/resparkable/share/share-dialog';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type {
  GrantTargetGroupWire,
  GrantWire,
  ShareLinkWire,
} from '@/lib/framework/resparkable/ui/payloads';

// ─── Fetch mock ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGrant(overrides: Partial<GrantWire> = {}): GrantWire {
  return {
    id: 'grant-1',
    entityType: 'project',
    entityId: 'proj-1',
    granteeEmail: 'friend@example.com',
    granteeGroup: null,
    role: 'viewer',
    includeTaskDetail: false,
    accepted: true,
    invitedAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    revokedAt: null,
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** A group this workspace can share with (§23.7, phase 49). */
function makeTargetGroup(overrides: Partial<GrantTargetGroupWire> = {}): GrantTargetGroupWire {
  return {
    groupId: 'group-1',
    spaceId: 'space-1',
    name: 'Study Group B',
    memberCount: 4,
    ...overrides,
  };
}

/** A grant to a group rather than a person: `granteeEmail` is null, `granteeGroup` is set. */
function makeGroupGrant(overrides: Partial<GrantWire> = {}): GrantWire {
  return {
    id: 'grant-group-1',
    entityType: 'project',
    entityId: 'proj-1',
    granteeEmail: null,
    granteeGroup: { spaceId: 'space-1', name: 'Study Group B', memberCount: 4 },
    role: 'viewer',
    includeTaskDetail: false,
    accepted: true,
    invitedAt: null,
    expiresAt: null,
    revokedAt: null,
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeShareLink(overrides: Partial<ShareLinkWire> = {}): ShareLinkWire {
  return {
    id: 'link-1',
    entityType: 'project',
    entityId: 'proj-1',
    tokenPrefix: 'abcd1234',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    active: true,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Typed as the props, not inferred: `entityType` widens to `string` on a bare
// object literal, which is what let this helper drift from the component's own
// union until the union was tightened.
const props: Omit<ShareDialogProps, 'filterBoard' | 'onSnapshot'> = {
  open: true,
  onOpenChange: vi.fn(),
  entityType: 'project',
  entityId: 'proj-1',
  title: 'Acme Redesign',
};

describe('ShareDialog', () => {
  it('renders two tabs: People and Public link', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    render(<ShareDialog {...props} />);

    expect(screen.getByRole('tab', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Public link' })).toBeInTheDocument();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  describe('People tab', () => {
    it('submits POST /grants with the typed values, then POSTs the invite — in that order', async () => {
      const user = userEvent.setup();
      const createdGrant = makeGrant({
        id: 'grant-99',
        granteeEmail: 'friend@example.com',
        accepted: false,
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { grant: createdGrant } })) // create
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { sent: true } })) // invite
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [createdGrant] })); // reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await user.type(screen.getByLabelText('Email address'), 'friend@example.com');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));

      expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.GRANTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: 'project',
          entityId: 'proj-1',
          granteeEmail: 'friend@example.com',
          role: 'viewer',
          includeTaskDetail: false,
        }),
      });

      expect(mockFetch).toHaveBeenNthCalledWith(3, RESPARKABLE_API.grantInvite('grant-99'), {
        method: 'POST',
      });

      // Order matters: the invite call happened strictly after the create call.
      const createCallOrder = mockFetch.mock.invocationCallOrder[1];
      const inviteCallOrder = mockFetch.mock.invocationCallOrder[2];
      expect(inviteCallOrder).toBeGreaterThan(createCallOrder);
    });

    it('still reports the share as succeeded when the invite email fails to send', async () => {
      const user = userEvent.setup();
      const createdGrant = makeGrant({ id: 'grant-1', accepted: false });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { grant: createdGrant } })) // create
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'MAIL_DOWN' } }, 500)) // invite fails
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [createdGrant] })); // reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await user.type(screen.getByLabelText('Email address'), 'friend@example.com');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      expect(
        await screen.findByText(
          'Shared. The email could not be sent, but they can still open it. Try sending again.'
        )
      ).toBeInTheDocument();
      // Not an error — the grant is a database fact regardless of the email outcome.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders a share error when the create request itself throws', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // mount load
        .mockRejectedValueOnce(new Error('network down')); // create throws

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await user.type(screen.getByLabelText('Email address'), 'friend@example.com');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not share this.');
    });

    it('shows an "invited" badge only on an unaccepted grant', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            makeGrant({ id: 'g-invited', granteeEmail: 'pending@example.com', accepted: false }),
            makeGrant({ id: 'g-accepted', granteeEmail: 'joined@example.com', accepted: true }),
          ],
        })
      );

      render(<ShareDialog {...props} />);

      const pendingRow = (await screen.findByText('pending@example.com')).closest('li');
      const acceptedRow = screen.getByText('joined@example.com').closest('li');
      if (pendingRow === null || acceptedRow === null) throw new Error('grant row not found');

      expect(within(pendingRow).getByText('invited')).toBeInTheDocument();
      expect(within(acceptedRow).queryByText('invited')).not.toBeInTheDocument();
    });

    it('shows a "can comment" badge for a commenter grant', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [makeGrant({ role: 'commenter' })] })
      );

      render(<ShareDialog {...props} />);

      expect(await screen.findByText('can comment')).toBeInTheDocument();
    });

    it('"Email again" re-sends the invite and posts a fresh notice', async () => {
      const user = userEvent.setup();
      const grant = makeGrant({ id: 'grant-1', granteeEmail: 'friend@example.com' });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [grant] })) // mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { sent: true } })); // invite

      render(<ShareDialog {...props} />);
      await screen.findByText('friend@example.com');

      await user.click(screen.getByRole('button', { name: /email friend@example.com again/i }));

      await waitFor(() =>
        expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.grantInvite('grant-1'), {
          method: 'POST',
        })
      );
      expect(await screen.findByText('Email sent again.')).toBeInTheDocument();
    });

    it('renders an error rather than crashing when the grant list fails to load', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      render(<ShareDialog {...props} />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load who this is shared with.'
      );
    });

    it('revoke calls DELETE on /grants/{id} and reloads the list', async () => {
      const user = userEvent.setup();
      const grant = makeGrant({ id: 'grant-7', granteeEmail: 'gone@example.com' });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [grant] })) // mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: {} })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // reload

      render(<ShareDialog {...props} />);
      expect(await screen.findByText('gone@example.com')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /stop sharing with gone@example.com/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.grant('grant-7'), {
        method: 'DELETE',
      });
      expect(
        await screen.findByText('This is not shared with any person yet.')
      ).toBeInTheDocument();
    });
  });

  describe('Groups tab', () => {
    async function openGroupsTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole('tab', { name: 'Groups' }));
    }

    it('lists the groups this can be shared with, and existing group grants, filtering out person grants', async () => {
      const user = userEvent.setup();
      const personGrant = makeGrant({ id: 'grant-person-1', granteeEmail: 'friend@example.com' });
      const groupGrant = makeGroupGrant({
        id: 'grant-group-1',
        granteeGroup: { spaceId: 'space-1', name: 'Study Group B', memberCount: 4 },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [personGrant, groupGrant] })) // Groups tab grants load
        .mockResolvedValueOnce(
          jsonResponse({ success: true, data: [makeTargetGroup({ memberCount: 1 })] })
        ); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      expect(mockFetch.mock.calls[1][0]).toBe(
        `${RESPARKABLE_API.GRANTS}?entityType=project&entityId=proj-1`
      );
      expect(mockFetch.mock.calls[2][0]).toBe(RESPARKABLE_API.GRANT_GROUPS);

      // The group grant is shown, with its member count. The person grant
      // belongs to the People tab and must not appear here.
      expect(await screen.findByText('Study Group B')).toBeInTheDocument();
      expect(screen.getByText('4 people')).toBeInTheDocument();
      expect(screen.queryByText('friend@example.com')).not.toBeInTheDocument();

      // The target group option is named with its own (singular) member count.
      expect(
        within(screen.getByLabelText('Group')).getByText('Study Group B (1 person)')
      ).toBeInTheDocument();
    });

    it('POSTs granteeSpaceId, never granteeEmail, when sharing with a group', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup({ spaceId: 'space-9', name: 'Research Crew', memberCount: 3 });
      const createdGrant = makeGroupGrant({
        id: 'grant-new',
        granteeGroup: { spaceId: 'space-9', name: 'Research Crew', memberCount: 3 },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })) // Groups tab target-groups load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { grant: createdGrant } })) // create
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [createdGrant] })) // reload: grants
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })); // reload: target groups

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      await user.selectOptions(screen.getByLabelText('Group'), 'space-9');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      // load() fetches both the grants list and the target-groups list on
      // every call, including the post-share reload, so a successful share
      // is 6 fetches in total, not 5.
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(6));

      const [, body] = mockFetch.mock.calls[3];
      expect(mockFetch.mock.calls[3][0]).toBe(RESPARKABLE_API.GRANTS);
      expect(body).toEqual({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: 'project',
          entityId: 'proj-1',
          granteeSpaceId: 'space-9',
          role: 'viewer',
          includeTaskDetail: false,
        }),
      });
      expect(JSON.parse(body.body as string)).not.toHaveProperty('granteeEmail');

      expect(
        await screen.findByText('Shared with Research Crew. Everyone in it can see it now.')
      ).toBeInTheDocument();
    });

    it('shows the member count and, on a filter board, the snapshot recommendation once a group is chosen', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup({ spaceId: 'space-9', name: 'Research Crew', memberCount: 3 });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })); // Groups tab target-groups load

      render(
        <ShareDialog {...props} filterBoard={{ summary: 'Tasks tagged urgent', cardCount: 5 }} />
      );
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      await user.selectOptions(screen.getByLabelText('Group'), 'space-9');

      expect(
        screen.getByText(/3 people in Research Crew will be able to see this today\./)
      ).toBeInTheDocument();
      expect(screen.getByText(/a snapshot is the safer choice/)).toBeInTheDocument();
    });

    it('does not mention snapshots for a group share on a plain (non-filter) board', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup({ spaceId: 'space-9', name: 'Research Crew', memberCount: 3 });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      await user.selectOptions(screen.getByLabelText('Group'), 'space-9');

      expect(
        screen.getByText(/3 people in Research Crew will be able to see this today\./)
      ).toBeInTheDocument();
      expect(screen.queryByText(/a snapshot is the safer choice/)).not.toBeInTheDocument();
    });

    it('shows a share error when the group create response fails to parse', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup({ spaceId: 'space-9', name: 'Research Crew' });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })) // Groups tab target-groups load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { nonsense: true } })); // malformed create

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      await user.selectOptions(screen.getByLabelText('Group'), 'space-9');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not share this with that group.'
      );
    });

    it('shows a share error when the group create request itself throws', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup({ spaceId: 'space-9', name: 'Research Crew' });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })) // Groups tab target-groups load
        .mockRejectedValueOnce(new Error('network down')); // create throws

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

      await user.selectOptions(screen.getByLabelText('Group'), 'space-9');
      await user.click(screen.getByRole('button', { name: /^share$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not share this with that group.'
      );
    });

    it('renders an error rather than crashing when the group grants load fails', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockRejectedValueOnce(new Error('network down')) // Groups tab grants load fails
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load the groups this is shared with.'
      );
    });

    it('renders an error rather than crashing when the target-groups load fails', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockRejectedValueOnce(new Error('network down')); // Groups tab target-groups load fails

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load the groups this is shared with.'
      );
    });

    it('shows the combined empty state when there are no groups to share with and nothing shared yet', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);

      expect(
        await screen.findByText(/There is no other group you can share into yet/)
      ).toBeInTheDocument();
      // Neither the form nor a redundant "not shared with any group yet" line.
      expect(screen.queryByLabelText('Group')).not.toBeInTheDocument();
    });

    it('shows "not shared with any group yet" when groups are available but none has been granted', async () => {
      const user = userEvent.setup();
      const target = makeTargetGroup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [target] })); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);

      expect(await screen.findByText('This is not shared with any group yet.')).toBeInTheDocument();
      // The form is still offered: there is a group available to share with.
      expect(screen.getByLabelText('Group')).toBeInTheDocument();
    });

    it('shows a "can comment" badge and expiry for a group grant', async () => {
      const user = userEvent.setup();
      const groupGrant = makeGroupGrant({
        role: 'commenter',
        expiresAt: '2026-06-01T00:00:00Z',
        granteeGroup: { spaceId: 'space-1', name: 'Study Group B', memberCount: 4 },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [groupGrant] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // Groups tab target-groups load

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);

      expect(await screen.findByText('can comment')).toBeInTheDocument();
      expect(screen.getByText(/until/)).toBeInTheDocument();
    });

    it('revoke calls DELETE on /grants/{id} and reloads the group grant list', async () => {
      const user = userEvent.setup();
      const groupGrant = makeGroupGrant({
        id: 'grant-group-7',
        granteeGroup: { spaceId: 'space-1', name: 'Study Group B', memberCount: 4 },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [groupGrant] })) // Groups tab grants load
        // Non-empty so the reload lands on "not shared with any group yet"
        // rather than the combined empty state, which needs both lists empty.
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [makeTargetGroup()] })) // Groups tab target-groups load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: {} })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Groups tab grants reload
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [makeTargetGroup()] })); // Groups tab target-groups reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      expect(await screen.findByText('Study Group B')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /stop sharing with study group b/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(6));
      expect(mockFetch.mock.calls[3][0]).toBe(RESPARKABLE_API.grant('grant-group-7'));
      expect(mockFetch.mock.calls[3][1]).toEqual({ method: 'DELETE' });
      expect(await screen.findByText('This is not shared with any group yet.')).toBeInTheDocument();
    });

    it('says so when the revoke fails, and keeps the grant listed', async () => {
      const user = userEvent.setup();
      const groupGrant = makeGroupGrant({
        id: 'grant-group-7',
        granteeGroup: { spaceId: 'space-1', name: 'Study Group B', memberCount: 4 },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [groupGrant] })) // Groups tab grants load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [makeTargetGroup()] })) // Groups tab target-groups load
        .mockResolvedValueOnce(
          jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'x' } }, 404)
        ); // DELETE

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await openGroupsTab(user);
      expect(await screen.findByText('Study Group B')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /stop sharing with study group b/i }));

      expect(
        await screen.findByText('Could not stop sharing with that group. Try again.')
      ).toBeInTheDocument();
      // No reload after a failed revoke: the list still shows the live grant.
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(screen.getByText('Study Group B')).toBeInTheDocument();
    });
  });

  describe('Public link tab', () => {
    it('renders an error when minting fails', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Link tab mount load
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'X' } }, 500)); // mint fails

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: /create a link/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not create a link.');
      expect(screen.queryByText('Copy this now. It is not shown again.')).not.toBeInTheDocument();
    });

    it('renders an error when the mint response fails the Zod parse', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Link tab mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { nonsense: true } })); // malformed

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: /create a link/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the new link.');
    });

    it('renders an error when the mint request itself rejects', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Link tab mount load
        .mockRejectedValueOnce(new Error('network down')); // mint rejects

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: /create a link/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not create a link.');
    });

    it('copying the minted link writes the absolute URL to the clipboard', async () => {
      const user = userEvent.setup();
      const clipboardWriteSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue(undefined);
      const link = makeShareLink();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Link tab mount load
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              link: {
                id: link.id,
                entityType: link.entityType,
                entityId: link.entityId,
                tokenPrefix: link.tokenPrefix,
                includeChildren: link.includeChildren,
                includeTaskDetail: link.includeTaskDetail,
                expiresAt: link.expiresAt,
                createdAt: link.createdAt,
              },
              token: 'plaintext-token-xyz789',
              path: '/s/plaintext-token-xyz789',
            },
          })
        ) // mint
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [link] })); // reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: /create a link/i }));
      await screen.findByText('Copy this now. It is not shown again.');

      await user.click(screen.getByRole('button', { name: /copy link/i }));

      expect(clipboardWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('/s/plaintext-token-xyz789')
      );

      clipboardWriteSpy.mockRestore();
    });

    it('revoke calls DELETE on /share-links/{id} and reloads', async () => {
      const user = userEvent.setup();
      const link = makeShareLink({ id: 'link-7', tokenPrefix: 'zzzz9999' });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [link] })) // Link tab mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: {} })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      expect(await screen.findByText('zzzz9999…')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /revoke this link/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));
      expect(mockFetch).toHaveBeenNthCalledWith(3, RESPARKABLE_API.shareLink('link-7'), {
        method: 'DELETE',
      });
      expect(await screen.findByText('There are no links to this item.')).toBeInTheDocument();
    });

    it('renders an error rather than crashing when the links list fails to load', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockRejectedValueOnce(new Error('network down')); // Link tab mount load

      const user = userEvent.setup();
      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('tab', { name: 'Public link' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load this item’s links.'
      );
    });

    it('minting shows the plaintext token exactly once with "copy it now" wording', async () => {
      const user = userEvent.setup();
      const link = makeShareLink();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // Link tab mount load
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              link: {
                id: link.id,
                entityType: link.entityType,
                entityId: link.entityId,
                tokenPrefix: link.tokenPrefix,
                includeChildren: link.includeChildren,
                includeTaskDetail: link.includeTaskDetail,
                expiresAt: link.expiresAt,
                createdAt: link.createdAt,
              },
              token: 'plaintext-token-xyz789',
              path: '/s/plaintext-token-xyz789',
            },
          })
        ) // mint
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [link] })); // reload

      render(<ShareDialog {...props} />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await user.click(screen.getByRole('tab', { name: 'Public link' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

      // The token has not been minted yet — it must not appear before creation.
      expect(screen.queryByDisplayValue(/plaintext-token-xyz789/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /create a link/i }));

      expect(await screen.findByText('Copy this now. It is not shown again.')).toBeInTheDocument();
      expect(screen.getByDisplayValue(/plaintext-token-xyz789/)).toBeInTheDocument();
    });
  });

  describe('filterBoard — §13 dynamic-filter mitigation', () => {
    const filterBoard = { summary: 'Tasks tagged urgent in Acme Redesign', cardCount: 13 };

    it('renders the summary, live count and snapshot button when present', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // People mount load

      render(<ShareDialog {...props} filterBoard={filterBoard} />);

      expect(screen.getByText('Tasks tagged urgent in Acme Redesign')).toBeInTheDocument();
      expect(screen.getByText('13 tasks match right now.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /share a snapshot instead/i })).toBeInTheDocument();
    });

    it('POSTs a board snapshot and shows the frozen message on success', async () => {
      const user = userEvent.setup();
      const onSnapshot = vi.fn();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: {} })); // snapshot POST

      render(<ShareDialog {...props} filterBoard={filterBoard} onSnapshot={onSnapshot} />);

      await user.click(screen.getByRole('button', { name: /share a snapshot instead/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.boardSnapshot('proj-1'), {
        method: 'POST',
      });
      expect(onSnapshot).toHaveBeenCalledTimes(1);

      expect(
        await screen.findByText(/this board now holds a fixed set of cards/i)
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /share a snapshot instead/i })
      ).not.toBeInTheDocument();
    });

    it('renders an error when the snapshot request fails', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // People mount load
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'X' } }, 500)); // snapshot fails

      render(<ShareDialog {...props} filterBoard={filterBoard} />);

      await user.click(screen.getByRole('button', { name: /share a snapshot instead/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not take a snapshot of this board.'
      );
      // Still offering the button — nothing was frozen.
      expect(screen.getByRole('button', { name: /share a snapshot instead/i })).toBeInTheDocument();
    });

    it('renders none of the filter-board mitigation when filterBoard is absent', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

      render(<ShareDialog {...props} />);

      expect(screen.queryByText(/tasks match right now/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /share a snapshot instead/i })
      ).not.toBeInTheDocument();
    });
  });
});
