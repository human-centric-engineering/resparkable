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

import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';
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

describe('viewerFromSession', () => {
  it('takes both the id and the address from the session', () => {
    // Not redundant: the id matches grants already accepted or issued to an
    // existing account, and the address matches grants issued to a mailbox
    // before its owner ever signed in. A viewer built from the id alone drops
    // every unaccepted invite, which is most of them on the day they are sent.
    expect(viewerFromSession(session())).toEqual({
      userId: 'user_b',
      email: 'b@example.com',
    });
  });

  it('lower-cases the address', () => {
    // The failure this prevents is silent: the viewer resolves, every query
    // runs, and the person simply holds none of their own grants.
    expect(viewerFromSession(session({ email: 'Bob@Example.COM' })).email).toBe('bob@example.com');
  });

  it('carries nothing else from the session', () => {
    // A viewer is an identity, not a user. Anything else on it would be a field
    // the access layer could start making decisions from without a resolution.
    expect(Object.keys(viewerFromSession(session())).sort()).toEqual(['email', 'userId']);
  });
});
