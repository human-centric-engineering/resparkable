/**
 * Unit Tests: building a `ResparkableViewer` from a session.
 *
 * Tiny, and worth its own file because it is the **single trust
 * boundary** for every cross-user read in the tier: `rg 'viewerFromSession\('`
 * is the complete list of places a viewer is built at all, and the two ways to
 * get one wrong are both one careless line that fails no other test.
 *
 *   1. Taking the identity from the request rather than the session, which turns
 *      the access layer into a lookup service for other people's brains.
 *   2. Forgetting to lower-case the address. A grant is addressed by email until
 *      it is accepted and `granteeClauses` matches the lower-cased form, so a
 *      session carrying `Bob@Example.com` against a grant stored as
 *      `bob@example.com` produces a viewer holding NONE of the grants issued to
 *      them — which looks like "sharing is broken for some people" and is
 *      invisible to any test written with lower-case fixtures.
 *   3. Carrying an address the account has not verified (phase 66), which on a
 *      deploy with verification off hands a stranger the real owner's shares.
 *      The session's cached `false` is checked against the `user` row, so a
 *      confirmation made elsewhere counts at once.
 *
 * @see lib/framework/resparkable/api/viewer.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emailVerifiedNow, viewerFor } from '@/lib/framework/resparkable/api/viewer';
import { readEmailVerified } from '@/lib/framework/resparkable/repo/grants';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import type { AuthSession } from '@/lib/auth/guards';

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

// The one DB read here: the fresh look at `emailVerified` when the cached
// session says false. Defaults to the row agreeing with the session.
vi.mock('@/lib/framework/resparkable/repo/grants', () => ({
  readEmailVerified: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(readEmailVerified).mockReset();
  vi.mocked(readEmailVerified).mockResolvedValue(false);
});

const PERSONAL = spaceScopeFor({ spaceId: 'user_b', actorUserId: 'user_b', role: 'owner' });
const GROUP_SPACE = 'spc_0123456789abcdef0123456789abcdef';

describe('viewerFor', () => {
  it('takes both the id and the address from the session', async () => {
    // Not redundant: the id matches grants already accepted or issued to an
    // existing account, and the address matches grants issued to a mailbox
    // before its owner ever signed in. A viewer built from the id alone drops
    // every unaccepted invite, which is most of them on the day they are sent.
    expect(await viewerFor(session(), PERSONAL)).toEqual({
      userId: 'user_b',
      email: 'b@example.com',
      group: null,
    });
  });

  it('lower-cases the address', async () => {
    // The failure this prevents is silent: the viewer resolves, every query
    // runs, and the person simply holds none of their own grants.
    expect((await viewerFor(session({ email: 'Bob@Example.COM' }), PERSONAL)).email).toBe(
      'bob@example.com'
    );
  });

  it('carries no address for an account that has not verified it', async () => {
    // Phase 66. With verification off, anybody can sign up under somebody
    // else's address, and a viewer carrying it would read every share made to
    // that mailbox. The id still matches the grants bound to this account.
    expect(await viewerFor(session({ emailVerified: false }), PERSONAL)).toEqual({
      userId: 'user_b',
      email: null,
      group: null,
    });
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

  it('names the group workspace when the scope is a group space', async () => {
    // Inside a group, the group is the grantee (phase 49). The space comes off
    // the scope membership minted, never off the request.
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'member' });
    expect((await viewerFor(session(), scope)).group).toEqual({
      spaceId: GROUP_SPACE,
      canWrite: true,
      canAdminister: false,
    });
  });

  it('marks a group viewer as unable to write, so a commenter grant does not let them comment', async () => {
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'viewer' });
    expect((await viewerFor(session(), scope)).group).toEqual({
      spaceId: GROUP_SPACE,
      canWrite: false,
      canAdminister: false,
    });
  });

  it('carries the address once the account has verified, even before the session cache catches up', async () => {
    // The session caches `emailVerified` for five minutes. Somebody who
    // confirmed on their phone must not be refused on their laptop meanwhile.
    vi.mocked(readEmailVerified).mockResolvedValue(true);

    expect((await viewerFor(session({ emailVerified: false }), PERSONAL)).email).toBe(
      'b@example.com'
    );
    expect(readEmailVerified).toHaveBeenCalledWith('user_b');
  });
});

describe('emailVerifiedNow', () => {
  it('trusts a verified session without reading the row', async () => {
    // An address does not become unverified, so `true` cannot be stale.
    expect(await emailVerifiedNow(session())).toBe(true);
    expect(readEmailVerified).not.toHaveBeenCalled();
  });

  it('reads the row for an unverified session, by the session id', async () => {
    vi.mocked(readEmailVerified).mockResolvedValue(true);

    expect(await emailVerifiedNow(session({ emailVerified: false }))).toBe(true);
    expect(readEmailVerified).toHaveBeenCalledWith('user_b');
  });

  it('stays false when the row agrees with the session', async () => {
    expect(await emailVerifiedNow(session({ emailVerified: false }))).toBe(false);
  });
});
