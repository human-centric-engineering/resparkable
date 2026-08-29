/**
 * Unit Tests: `AcceptInvite` — the page an invite email lands on.
 *
 * Test coverage, per the component's own docblock:
 * - Accepts on mount: `POST /api/v1/resparkable/invites/accept` with the token.
 * - On success, redirects with `router.replace` — not `push` — so the spent
 *   invite URL never sits in the back stack.
 * - `accepted: false` renders the wrong-account state, showing the *masked*
 *   address the server sent, never an unmasked one.
 * - A 404 renders the "not available" state, and that state must not prompt
 *   the reader to ask for a new link — §13 is explicit that this page must
 *   not become an oracle about invitations, or a suggestion machine for
 *   conversations the owner did not choose to have.
 *
 * @see components/resparkable/share/accept-invite.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useRouter } from 'next/navigation';

import { AcceptInvite } from '@/components/resparkable/share/accept-invite';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
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

const TOKEN = 'invite-token-abc123';

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(useRouter).mockReturnValue(createMockRouter());
});

describe('AcceptInvite', () => {
  it('POSTs to the accept endpoint with the token on mount', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { accepted: true, entityType: 'project', entityId: 'item-1' },
      })
    );

    render(<AcceptInvite token={TOKEN} />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith(RESPARKABLE_API.ACCEPT_INVITE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  it('redirects with router.replace, never push, on success', async () => {
    const router = createMockRouter();
    vi.mocked(useRouter).mockReturnValue(router);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { accepted: true, entityType: 'project', entityId: 'item-42' },
      })
    );

    render(<AcceptInvite token={TOKEN} />);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        RESPARKABLE_ROUTES.sharedItem('project', 'item-42')
      )
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('renders the wrong-account state with the masked address on accepted: false', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { accepted: false, expectedEmail: 'a***@e***.com' },
      })
    );

    render(<AcceptInvite token={TOKEN} />);

    expect(await screen.findByText('This was shared with a different account')).toBeInTheDocument();
    expect(screen.getByText(/a\*\*\*@e\*\*\*\.com/)).toBeInTheDocument();
  });

  it('renders the "not available" state on a 404, without prompting for a new link', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND' } }, 404)
    );

    render(<AcceptInvite token={TOKEN} />);

    expect(await screen.findByText('This is not available')).toBeInTheDocument();
    expect(
      screen.getByText('The link may be out of date, or what it pointed at is no longer shared.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/ask/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send it again/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/request a new/i)).not.toBeInTheDocument();
  });

  it('renders the "not available" state when the payload fails the Zod parse', async () => {
    // `accepted` is required to be a boolean; this response fails the schema.
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { accepted: 'yes' } }));

    render(<AcceptInvite token={TOKEN} />);

    expect(await screen.findByText('This is not available')).toBeInTheDocument();
  });

  it('renders the "not available" state when the fetch itself throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    render(<AcceptInvite token={TOKEN} />);

    expect(await screen.findByText('This is not available')).toBeInTheDocument();
  });
});
