// @vitest-environment happy-dom

/**
 * Unit Tests: `GroupJoinLinks`, the admin's join-link panel (§23.11, phase 57).
 *
 * What has to hold:
 *
 *   1. **A forwarded join link is the whole thing.** The warning sentence is
 *      on screen unconditionally, because unlike an invitation a link names
 *      nobody.
 *   2. **Approval follows the role until the admin touches it.** `request` is
 *      the default for `member`, `open` for `viewer`, and once the admin
 *      picks one explicitly it stops following the role select.
 *   3. **The mint POST carries exactly what the form says**: role, the
 *      effective approval, `maxUses: null` when the field is empty, and
 *      either `{kind: 'days', days}` or `{kind: 'never'}` for expiry.
 *   4. **The minted link is shown once**, with the "only time" copy, and
 *      prepended to the list stripped of its token.
 *   5. **The list renders a link's true state**: live, revoked, expired, or
 *      used up. The revoke button follows revoked-or-expired, not used-up: a
 *      used-up link is not dead, because turning down a request made through
 *      it gives a use back, so it stays revocable.
 *   6. **Revoking is optimistic, with a rollback** on failure.
 *   7. **A mint response that fails to parse says so**, adds nothing to the
 *      list, and clears on the next mint attempt.
 *
 * @see components/resparkable/groups/group-join-links.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

import { GroupJoinLinks } from '@/components/resparkable/groups/group-join-links';
import { apiClient } from '@/lib/api/client';
import type { GroupJoinLinkWire } from '@/lib/framework/resparkable/ui/payloads';

const GROUP_ID = 'grp_1';

function linkFixture(overrides: Partial<GroupJoinLinkWire> = {}): GroupJoinLinkWire {
  return {
    id: 'link_1',
    tokenPrefix: 'abc123',
    role: 'member',
    approval: 'request',
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The select's visible value, read off its trigger by element id. */
function selectValue(id: string): string | null {
  return document.getElementById(id)?.textContent ?? null;
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  triggerId: string,
  optionName: string
) {
  const trigger = document.getElementById(triggerId);
  if (!trigger) throw new Error(`no trigger #${triggerId}`);
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupJoinLinks', () => {
  it('warns unconditionally that a forwarded link is the whole thing', () => {
    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);

    expect(
      screen.getByText(/If it is forwarded, it works for whoever it reaches/)
    ).toBeInTheDocument();
    expect(screen.getByText(/A link can never make somebody an admin/)).toBeInTheDocument();
  });

  it('defaults approval to "Needs an admin to let them in" for a member link and "Joins straight away" once switched to viewer', async () => {
    const user = userEvent.setup();
    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);

    expect(selectValue('join-approval')).toBe('Needs an admin to let them in');

    await pick(user, 'join-role', 'viewer');

    expect(selectValue('join-approval')).toBe('Joins straight away');
  });

  it('stops following the role once the admin picks an approval explicitly', async () => {
    const user = userEvent.setup();
    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);

    // Two real picks, landing back on the member default ("Needs an admin to
    // let them in"), but now as the admin's explicit choice, not the tracked
    // default.
    await pick(user, 'join-approval', 'Joins straight away');
    expect(selectValue('join-approval')).toBe('Joins straight away');
    await pick(user, 'join-approval', 'Needs an admin to let them in');
    expect(selectValue('join-approval')).toBe('Needs an admin to let them in');

    // The viewer default is "Joins straight away". If the select still
    // followed the role, switching to viewer would show that now. It does
    // not: the admin's explicit pick holds.
    await pick(user, 'join-role', 'viewer');
    expect(selectValue('join-approval')).toBe('Needs an admin to let them in');
  });

  it('mints a link with the default approval, no use limit, and the chosen expiry', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      ...linkFixture(),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    });

    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1/join-links', {
      body: {
        role: 'member',
        approval: 'request',
        maxUses: null,
        expiry: { kind: 'days', days: 30 },
      },
    });
  });

  it('sends the typed max uses as a number, and {kind: "never"} when the checkbox is ticked', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      ...linkFixture(),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    });

    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    const usesInput = document.getElementById('join-max-uses');
    if (!usesInput) throw new Error('no #join-max-uses input');
    await user.type(usesInput, '5');
    await user.click(screen.getByRole('checkbox', { name: 'Never expires' }));
    await user.click(screen.getByRole('button', { name: /create link/i }));

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/resparkable/groups/grp_1/join-links', {
      body: {
        role: 'member',
        approval: 'request',
        maxUses: 5,
        expiry: { kind: 'never' },
      },
    });
  });

  it('shows the minted link once, with the "only time" copy, and adds it to the list without its token', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({
      ...linkFixture({ id: 'link_new', tokenPrefix: 'xyz789' }),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    });

    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));

    expect(
      await screen.findByDisplayValue(
        'https://resparkable.test/resparkable/groups/join/plaintext-token'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/This is the only time the whole link is shown/)).toBeInTheDocument();

    // The list shows the prefix, not the plaintext token.
    expect(screen.getByText(/xyz789/)).toBeInTheDocument();
    expect(screen.queryByText('plaintext-token')).not.toBeInTheDocument();
  });

  it('shows an alert and adds nothing to the list when the 201 response fails schema parsing', async () => {
    const user = userEvent.setup();
    // Missing every required field of `mintedJoinLinkSchema`: a shape the
    // server should never send, but the one the parse-failure path exists for.
    vi.mocked(apiClient.post).mockResolvedValue({ nonsense: true });

    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));

    // The link WAS created server-side, so silence would leave a live
    // credential nobody can see; the alert has to say what to do about it.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The link was created but could not be shown. Reload the page and revoke it, then create another.'
    );
    expect(screen.getByText('No join links yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('The new join link')).not.toBeInTheDocument();
  });

  it('clears the parse-failure alert on the next mint attempt', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValueOnce({ nonsense: true });

    render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    vi.mocked(apiClient.post).mockResolvedValueOnce({
      ...linkFixture({ id: 'link_new', tokenPrefix: 'xyz789' }),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    });
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await screen.findByDisplayValue(
      'https://resparkable.test/resparkable/groups/join/plaintext-token'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the once-only minted URL on screen when a refetch supplies a new links array that includes it', async () => {
    const user = userEvent.setup();
    const minted = {
      ...linkFixture({ id: 'link_new', tokenPrefix: 'xyz789' }),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    };
    vi.mocked(apiClient.post).mockResolvedValue(minted);

    const { rerender } = render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));
    expect(await screen.findByDisplayValue(minted.url)).toBeInTheDocument();

    // A parent refetch (a poll, a tab remount's fetch resolving late) now
    // includes the link that was just minted, as a brand-new array. Not a
    // `key` on the parent, and not the same array reference: this is exactly
    // the case `useEffect` following `links` has to survive.
    const { token: _token, url: _url, ...link } = minted;
    rerender(<GroupJoinLinks groupId={GROUP_ID} links={[link]} />);

    // Only the digest is stored server-side, so if the once-only URL is wiped
    // here it is gone for good.
    expect(screen.getByDisplayValue(minted.url)).toBeInTheDocument();
  });

  it('keeps a link minted before a slow list fetch resolves, with its revoke button', async () => {
    const user = userEvent.setup();
    const minted = {
      ...linkFixture({ id: 'link_new', tokenPrefix: 'xyz789' }),
      token: 'plaintext-token',
      url: 'https://resparkable.test/resparkable/groups/join/plaintext-token',
    };
    vi.mocked(apiClient.post).mockResolvedValue(minted);
    const older = linkFixture({ id: 'link_old', tokenPrefix: 'old111' });

    const { rerender } = render(<GroupJoinLinks groupId={GROUP_ID} links={[]} />);
    await user.click(screen.getByRole('button', { name: /create link/i }));
    await screen.findByDisplayValue(minted.url);

    // The workspace tab's fetch started before the mint and resolves after it,
    // so it does not carry the new link. Replacing the list outright would
    // leave a live credential on screen with no row to revoke it from.
    rerender(<GroupJoinLinks groupId={GROUP_ID} links={[older]} />);

    expect(screen.getByText(/xyz789/)).toBeInTheDocument();
    expect(screen.getByText(/old111/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /revoke/i })).toHaveLength(2);
  });

  it('shows the prefix and "N of M" uses for a link with a use limit', () => {
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ tokenPrefix: 'lim999', useCount: 2, maxUses: 5 })]}
      />
    );

    expect(screen.getByText(/lim999/)).toBeInTheDocument();
    expect(screen.getByText(/used 2 of 5/)).toBeInTheDocument();
  });

  it('names a request-approval link "needs an admin to let them in" in the list row, not "you approve"', () => {
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ tokenPrefix: 'req001', approval: 'request' })]}
      />
    );

    expect(screen.getByText(/needs an admin to let them in/)).toBeInTheDocument();
    expect(screen.queryByText(/you approve/i)).not.toBeInTheDocument();
  });

  it('names an open-approval link "joins straight away" in the list row', () => {
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ tokenPrefix: 'open001', approval: 'open' })]}
      />
    );

    expect(screen.getByText(/joins straight away/)).toBeInTheDocument();
  });

  it('marks a revoked link as revoked and offers no revoke button for it', () => {
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ id: 'link_revoked', revokedAt: '2026-09-10T00:00:00.000Z' })]}
      />
    );

    expect(screen.getByText(/· revoked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke the join link/i })).not.toBeInTheDocument();
  });

  it('marks an expired link as expired and offers no revoke button for it', () => {
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ id: 'link_expired', expiresAt: '2020-01-01T00:00:00.000Z' })]}
      />
    );

    expect(screen.getByText(/· expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke the join link/i })).not.toBeInTheDocument();
  });

  it('marks a used-up link as used up, but still offers a revoke button for it', () => {
    // A used-up link is not dead: turning down a request made through it
    // gives a use back, so an admin has to be able to revoke it too.
    render(
      <GroupJoinLinks
        groupId={GROUP_ID}
        links={[linkFixture({ id: 'link_used', tokenPrefix: 'used001', useCount: 3, maxUses: 3 })]}
      />
    );

    expect(screen.getByText(/· used up/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke the join link starting used001' })
    ).toBeInTheDocument();
  });

  it('offers a revoke button for a live link', () => {
    render(<GroupJoinLinks groupId={GROUP_ID} links={[linkFixture({ tokenPrefix: 'live001' })]} />);

    expect(
      screen.getByRole('button', { name: 'Revoke the join link starting live001' })
    ).toBeInTheDocument();
  });

  it('revokes a link at once, and rolls it back when the server refuses', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('offline'));

    render(<GroupJoinLinks groupId={GROUP_ID} links={[linkFixture({ tokenPrefix: 'roll001' })]} />);
    await user.click(screen.getByRole('button', { name: 'Revoke the join link starting roll001' }));

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/api/v1/resparkable/groups/grp_1/join-links/link_1'
    );

    // Optimistic, then honest: a link shown as revoked that is still live
    // would be somebody trusting a door that is not actually shut.
    expect(
      await screen.findByRole('button', { name: 'Revoke the join link starting roll001' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/· revoked/)).not.toBeInTheDocument();
  });
});
