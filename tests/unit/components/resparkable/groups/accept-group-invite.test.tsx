// @vitest-environment happy-dom

/**
 * Unit Tests: `AcceptGroupInvite`, the page a group-invitation email lands on.
 *
 * Test coverage, per the component's own docblock:
 * - Does NOT accept on mount. Unlike `AcceptInvite`, joining a group creates
 *   read and write access to an entire shared workspace with no private
 *   tier, so clicking a link in an email is not consent. No `fetch` happens
 *   until the reader presses the button.
 * - The offered state names what joining means (shared with everyone in the
 *   group) before the reader commits.
 * - On success it renders the group name and does NOT redirect: phase 46
 *   ships no group surface to redirect to.
 * - `alreadyMember: true` renders a different message from a fresh join.
 * - The wrong-account state shows the masked address the server sent, never
 *   an unmasked one.
 * - A malformed/unparseable response renders the "not available" state
 *   rather than throwing, identical for withdrawn, expired, unknown or
 *   spent invitations.
 * - The button disables while the request is in flight, so a double-click
 *   cannot send two accepts.
 *
 * @see components/resparkable/groups/accept-group-invite.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { AcceptGroupInvite } from '@/components/resparkable/groups/accept-group-invite';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { createMockRouter } from '@/tests/types/mocks';

// ─── Fetch mock ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN = 'group-invite-token-abc123';

function clickJoin(): Promise<void> {
  return userEvent.setup().click(screen.getByRole('button', { name: /join the group/i }));
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(useRouter).mockReturnValue(createMockRouter());
});

describe('AcceptGroupInvite', () => {
  it('does not fetch on mount, unlike the share-invite flow', async () => {
    render(<AcceptGroupInvite token={TOKEN} />);

    // Give any accidental mount-effect a tick to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('names what joining means before the reader commits', () => {
    render(<AcceptGroupInvite token={TOKEN} />);

    expect(screen.getByText('You have been invited to a group')).toBeInTheDocument();
    expect(screen.getByText(/A group workspace is shared with everyone in it/)).toBeInTheDocument();
  });

  it('POSTs to the accept endpoint with the token only once the button is pressed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { joined: true, groupName: 'Family Recipes', alreadyMember: false },
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    expect(mockFetch).not.toHaveBeenCalled();

    await clickJoin();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith(RESPARKABLE_API.ACCEPT_GROUP_INVITE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  it('renders the group name on success and does not redirect', async () => {
    const router = createMockRouter();
    vi.mocked(useRouter).mockReturnValue(router);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { joined: true, groupName: 'Family Recipes', alreadyMember: false },
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You have joined Family Recipes')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('renders a different message when alreadyMember is true', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { joined: true, groupName: 'Family Recipes', alreadyMember: true },
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You are already in this group')).toBeInTheDocument();
    expect(screen.queryByText('You have joined Family Recipes')).not.toBeInTheDocument();
  });

  it('renders the wrong-account state with the masked address, never unmasked', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { joined: false, reason: 'wrong_account', expectedEmail: 'a***@e***.com' },
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(
      await screen.findByText('This invitation was sent to a different account')
    ).toBeInTheDocument();
    expect(screen.getByText(/a\*\*\*@e\*\*\*\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/a[a-z0-9._%+-]*@e[a-z0-9.-]*\.com(?!\*)/i)).not.toBeInTheDocument();
  });

  it('renders the "not available" state on a 404', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND' } }, 404)
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This invitation is not available')).toBeInTheDocument();
  });

  it('renders the identical "not available" state for a spent invitation as for withdrawn or unknown', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { joined: false, reason: 'already_spent' },
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This invitation is not available')).toBeInTheDocument();
    expect(
      screen.getByText('The link may be out of date, or it may have been withdrawn.')
    ).toBeInTheDocument();
  });

  it('renders the "not available" state when the payload fails the Zod parse', async () => {
    // `joined` is required to be a boolean; this response fails the schema.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { joined: 'yes' } }));

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This invitation is not available')).toBeInTheDocument();
  });

  it('renders the "not available" state when the response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This invitation is not available')).toBeInTheDocument();
  });

  it('renders the "not available" state when the fetch itself throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    render(<AcceptGroupInvite token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This invitation is not available')).toBeInTheDocument();
  });

  it('disables the button while the request is in flight, so a double click cannot send two accepts', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    render(<AcceptGroupInvite token={TOKEN} />);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: /join the group/i });

    await user.click(button);

    const joiningButton = await screen.findByRole('button', { name: /joining/i });
    expect(joiningButton).toBeDisabled();

    // A second click while disabled must not trigger a second fetch.
    await user.click(joiningButton);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFetch(
      jsonResponse({
        success: true,
        data: { joined: true, groupName: 'Family Recipes', alreadyMember: false },
      })
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});
