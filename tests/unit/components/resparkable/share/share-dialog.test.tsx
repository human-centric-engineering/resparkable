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
 *
 * @see components/resparkable/share/share-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ShareDialog, type ShareDialogProps } from '@/components/resparkable/share/share-dialog';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GrantWire, ShareLinkWire } from '@/lib/framework/resparkable/ui/payloads';

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
      expect(await screen.findByText('This is not shared with anyone yet.')).toBeInTheDocument();
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
