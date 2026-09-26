// @vitest-environment happy-dom

/**
 * Unit Tests: `JoinGroup`, the page a group join link lands on (§23.11, phase 57).
 *
 * Test coverage, per the component's own docblock:
 * - Does NOT redeem on mount. Opening the link is not consent, the same
 *   reasoning `AcceptGroupInvite` gives, so no `fetch` happens until the
 *   reader presses the button.
 * - Each outcome the redeem route can answer (`joined`, `already_member`,
 *   `requested`, `already_requested`, `group_full`, `unknown`) renders its own
 *   message.
 * - `group_full` names the group; `unknown` does not, because the route sends
 *   no `groupName` for it.
 * - A 400, a non-success body, and an unparseable success body all render the
 *   identical "not available" state as a bad token.
 * - A response that says nothing about the link (429, 401, 500+, a body that
 *   is not JSON at all, or the fetch throwing outright) renders its own
 *   "failed" state instead, each with a Back button that returns to the
 *   offer rather than a dead end.
 *
 * @see components/resparkable/groups/join-group.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { JoinGroup } from '@/components/resparkable/groups/join-group';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN = 'group-join-token-abc123';

function clickJoin(): Promise<void> {
  return userEvent.setup().click(screen.getByRole('button', { name: /join the group/i }));
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('JoinGroup', () => {
  it('does not fetch on mount', async () => {
    render(<JoinGroup token={TOKEN} />);

    // Give any accidental mount-effect a tick to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('names what joining means before the reader commits', () => {
    render(<JoinGroup token={TOKEN} />);

    expect(screen.getByText('You have a link to join a group')).toBeInTheDocument();
    expect(screen.getByText(/A group workspace is shared with everyone in it/)).toBeInTheDocument();
  });

  it('POSTs the token to the redeem endpoint only once the button is pressed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'joined', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    expect(mockFetch).not.toHaveBeenCalled();

    await clickJoin();

    expect(mockFetch).toHaveBeenCalledWith(RESPARKABLE_API.JOIN_GROUP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  it('renders the group name and a link to it on joined', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'joined', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You have joined Study Group B')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the group' })).toHaveAttribute(
      'href',
      '/resparkable/groups/grp_1'
    );
  });

  it('renders the already-a-member state', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'already_member', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You are already in this group')).toBeInTheDocument();
  });

  it('renders the requested state, naming the group and pointing at your groups list', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'requested', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You have asked to join Study Group B')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute(
      'href',
      '/resparkable/groups'
    );
  });

  it('renders the already-requested state', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'already_requested', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(
      await screen.findByText('You have already asked to join this group')
    ).toBeInTheDocument();
  });

  it('names the group on group_full, and offers no link to a group you did not join', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { outcome: 'group_full', groupName: 'Study Group B' },
      })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('Study Group B is full')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to the group' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Your groups' })).not.toBeInTheDocument();
  });

  it('renders "This link is not available" for unknown, which names no group', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { outcome: 'unknown' } }));

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This link is not available')).toBeInTheDocument();
  });

  it('renders the identical "not available" state on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND' } }, 404)
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This link is not available')).toBeInTheDocument();
  });

  it('renders "This link is not available" on a 400, which is a malformed token', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'VALIDATION_ERROR' } }, 400)
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This link is not available')).toBeInTheDocument();
  });

  it('renders the "not available" state when the payload fails the Zod parse', async () => {
    // `outcome` must be one of the known enum values; this response fails the schema.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { outcome: 'something_else' } })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('This link is not available')).toBeInTheDocument();
  });

  it('renders "Too many tries today" on a 429, which says nothing about the link', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'RATE_LIMITED' } }, 429)
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('Too many tries today')).toBeInTheDocument();
    expect(screen.queryByText('This link is not available')).not.toBeInTheDocument();
  });

  it('renders "You are signed out" on a 401', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'UNAUTHENTICATED' } }, 401)
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('You are signed out')).toBeInTheDocument();
    expect(screen.queryByText('This link is not available')).not.toBeInTheDocument();
  });

  it('renders "Something went wrong" on a 500 or higher', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'INTERNAL' } }, 503)
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('This link is not available')).not.toBeInTheDocument();
  });

  it('renders "Could not reach the server" when the response body is not JSON at all', async () => {
    // Indistinguishable from a network glitch, so it gets the same treatment
    // as a thrown fetch rather than being read as a bad link.
    mockFetch.mockResolvedValueOnce(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('Could not reach the server')).toBeInTheDocument();
    expect(screen.queryByText('This link is not available')).not.toBeInTheDocument();
  });

  it('renders "Could not reach the server" when the fetch itself throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    render(<JoinGroup token={TOKEN} />);
    await clickJoin();

    expect(await screen.findByText('Could not reach the server')).toBeInTheDocument();
    expect(screen.queryByText('This link is not available')).not.toBeInTheDocument();
  });

  it('offers a Back button on a failed state that returns to the offer, ready to try again', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    render(<JoinGroup token={TOKEN} />);
    const user = userEvent.setup();
    await clickJoin();

    await user.click(await screen.findByRole('button', { name: 'Back' }));

    expect(screen.getByText('You have a link to join a group')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join the group/i })).toBeInTheDocument();
  });

  it('disables the button while the request is in flight, so a double click cannot send two redemptions', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    render(<JoinGroup token={TOKEN} />);
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
        data: { outcome: 'joined', groupId: 'grp_1', groupName: 'Study Group B' },
      })
    );
  });
});
