/**
 * Unit Tests: building a `ResparkableViewer` from a session.
 *
 * Tiny and pure, and worth its own file because it is the **single trust
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
 *
 * @see lib/framework/resparkable/api/viewer.ts
 */

import { describe, expect, it } from 'vitest';

import { viewerFor } from '@/lib/framework/resparkable/api/viewer';
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

const PERSONAL = spaceScopeFor({ spaceId: 'user_b', actorUserId: 'user_b', role: 'owner' });
const GROUP_SPACE = 'spc_0123456789abcdef0123456789abcdef';

describe('viewerFor', () => {
  it('takes both the id and the address from the session', () => {
    // Not redundant: the id matches grants already accepted or issued to an
    // existing account, and the address matches grants issued to a mailbox
    // before its owner ever signed in. A viewer built from the id alone drops
    // every unaccepted invite, which is most of them on the day they are sent.
    expect(viewerFor(session(), PERSONAL)).toEqual({
      userId: 'user_b',
      email: 'b@example.com',
      group: null,
    });
  });

  it('lower-cases the address', () => {
    // The failure this prevents is silent: the viewer resolves, every query
    // runs, and the person simply holds none of their own grants.
    expect(viewerFor(session({ email: 'Bob@Example.COM' }), PERSONAL).email).toBe(
      'bob@example.com'
    );
  });

  it('carries nothing else from the session', () => {
    // A viewer is an identity, not a user. Anything else on it would be a field
    // the access layer could start making decisions from without a resolution.
    expect(Object.keys(viewerFor(session(), PERSONAL)).sort()).toEqual([
      'email',
      'group',
      'userId',
    ]);
  });

  it('names the group workspace when the scope is a group space', () => {
    // Inside a group, the group is the grantee (phase 49). The space comes off
    // the scope membership minted, never off the request.
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'member' });
    expect(viewerFor(session(), scope).group).toEqual({ spaceId: GROUP_SPACE, canWrite: true });
  });

  it('marks a group viewer as unable to write, so a commenter grant does not let them comment', () => {
    const scope = spaceScopeFor({ spaceId: GROUP_SPACE, actorUserId: 'user_b', role: 'viewer' });
    expect(viewerFor(session(), scope).group).toEqual({ spaceId: GROUP_SPACE, canWrite: false });
  });
});
