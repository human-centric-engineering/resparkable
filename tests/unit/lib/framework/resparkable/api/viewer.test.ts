/**
 * Unit Tests: building a `ResparkableViewer` from a session.
 *
 * Tiny, and worth its own file because it is the **single trust boundary** for
 * every cross-user read in the tier: `rg 'viewerFor\('` is the complete list of
 * places a viewer is built at all, and the ways to get one wrong are each one
 * careless line that fails no other test.
 *
 *   1. Taking the identity from the request rather than the session, which turns
 *      the access layer into a lookup service for other people's brains.
 *   2. Forgetting to lower-case the address. A grant is addressed by email until
 *      it is accepted and `granteeClauses` matches the lower-cased form, so an
 *      account stored as `Bob@Example.com` against a grant stored as
 *      `bob@example.com` produces a viewer holding NONE of the grants issued to
 *      them, which looks like "sharing is broken for some people" and is
 *      invisible to any test written with lower-case fixtures.
 *   3. Carrying an address the account has not verified (phase 66), which on a
 *      deploy with verification off hands a stranger the real owner's shares.
 *   4. Taking the address or its flag from the session, which better-auth
 *      caches for five minutes. Both are read together from the `user` row, so
 *      a fresh flag can never vouch for an address the account no longer holds.
 *
 * @see lib/framework/resparkable/api/viewer.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountAddress, viewerFor } from '@/lib/framework/resparkable/api/viewer';
import { readAddressOwner } from '@/lib/framework/resparkable/repo/grants';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import type { AuthSession } from '@/lib/auth/guards';

// The one DB read here: the account's address and flag, by the session's id.
vi.mock('@/lib/framework/resparkable/repo/grants', () => ({
  readAddressOwner: vi.fn(),
}));

function session(overrides: Partial<AuthSession['user']> = {}): AuthSession {
  return {
    session: {
      id: 's_1',
      userId: 'user_b',
      token: 't',
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
    user: {
      id: 'user_b',
      name: 'Bo',
      email: 'b@example.com',
      emailVerified: true,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      ...overrides,
    },
  };
}

function row(email: string, emailVerified: boolean): void {
  vi.mocked(readAddressOwner).mockResolvedValue({ email, emailVerified });
}

beforeEach(() => {
  vi.mocked(readAddressOwner).mockReset();
  row('b@example.com', true);
});

const PERSONAL = spaceScopeFor({ spaceId: 'user_b', actorUserId: 'user_b', role: 'owner' });
const GROUP_SPACE = 'spc_0123456789abcdef0123456789abcdef';

describe('viewerFor', () => {
  it('takes the id from the session and the address from the account', async () => {
    // Not redundant: the id matches grants already accepted or issued to an
    // existing account, and the address matches grants issued to a mailbox
    // before its owner ever signed in. A viewer built from the id alone drops
    // every unaccepted invite, which is most of them on the day they are sent.
    expect(await viewerFor(session(), PERSONAL)).toEqual({
      userId: 'user_b',
      email: 'b@example.com',
      group: null,
    });
    expect(readAddressOwner).toHaveBeenCalledWith('user_b');
  });

  it('lower-cases the address', async () => {
    // The failure this prevents is silent: the viewer resolves, every query
    // runs, and the person simply holds none of their own grants.
    row('Bob@Example.COM', true);

    expect((await viewerFor(session(), PERSONAL)).email).toBe('bob@example.com');
  });

  it('carries no address for an account that has not verified it', async () => {
    // Phase 66. With verification off, anybody can sign up under somebody
    // else's address, and a viewer carrying it would read every share made to
    // that mailbox. The id still matches the grants bound to this account.
    row('b@example.com', false);

    expect(await viewerFor(session(), PERSONAL)).toEqual({
      userId: 'user_b',
      email: null,
      group: null,
    });
  });

  it('believes the account over a stale session, whichever way the flag moved', async () => {
    // Confirmed on another device since the session was cached: let in.
    row('b@example.com', true);
    expect((await viewerFor(session({ emailVerified: false }), PERSONAL)).email).toBe(
      'b@example.com'
    );

    // Un-verified by an admin since the session was cached: refused.
    row('b@example.com', false);
    expect((await viewerFor(session({ emailVerified: true }), PERSONAL)).email).toBeNull();
  });

  it('never pairs a fresh flag with the address the session still carries', async () => {
    // The account changed its address to one it verified. The cached session
    // still says the old one; matching on it would hand over what was sent to
    // that address's real owner.
    row('new@example.com', true);

    expect(
      (await viewerFor(session({ email: 'old@example.com', emailVerified: false }), PERSONAL)).email
    ).toBe('new@example.com');
  });

  it('carries nothing else from the session', async () => {
    // A viewer is an identity, not a user. Anything else on it would be a field
    // the access layer could start making decisions from without a resolution.
    expect(Object.keys(await viewerFor(session(), PERSONAL)).sort()).toEqual([
      'email',
      'group',
      'userId',
    ]);
  });

  it('names the group workspace when the scope is a group space, and reads no address', async () => {
    // Inside a group, the group is the grantee (phase 49). The space comes off
    // the scope membership minted, never off the request, and `granteeClauses`
    // never looks at an address there, so none is read.
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'member' });

    expect(await viewerFor(session(), scope)).toEqual({
      userId: 'user_b',
      email: null,
      group: { spaceId: GROUP_SPACE, canWrite: true, canAdminister: false },
    });
    expect(readAddressOwner).not.toHaveBeenCalled();
  });

  it('marks a group viewer as unable to write, so a commenter grant does not let them comment', async () => {
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'viewer' });
    expect((await viewerFor(session(), scope)).group).toEqual({
      spaceId: GROUP_SPACE,
      canWrite: false,
      canAdminister: false,
    });
  });
});

describe('accountAddress', () => {
  it('returns the row, not the session', async () => {
    row('new@example.com', true);

    expect(
      await accountAddress(session({ email: 'old@example.com', emailVerified: false }))
    ).toEqual({ email: 'new@example.com', emailVerified: true });
  });

  it('verifies nothing for an account deleted mid-session', async () => {
    vi.mocked(readAddressOwner).mockResolvedValue(null);

    expect(await accountAddress(session())).toEqual({ email: '', emailVerified: false });
  });
});
