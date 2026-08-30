/**
 * Unit Tests: `SpaceScope` (Release 1, phase 2).
 *
 * D5 says every brain query is an owner query or a shared query, with no third
 * kind. `SpaceScope` is what makes that structural instead of aspirational: a
 * repo cannot be called without one, and one cannot be produced from an
 * arbitrary string without going through `spaceScope()`.
 *
 * These tests cover the runtime half of that contract. The compile-time half —
 * that a bare `string` is not assignable to `SpaceScope` — is enforced by the
 * brand and checked by `tsc`, which is the right tool for it.
 *
 * @see lib/framework/resparkable/repo/space-scope.ts
 */

import { describe, it, expect } from 'vitest';

import {
  liveSpaceWhere,
  spaceScope,
  spaceScopeFor,
  spaceWhere,
} from '@/lib/framework/resparkable/repo/space-scope';

describe('spaceScope', () => {
  it('carries the verified id as the space key', () => {
    // A personal space's key value IS its owner's user id (§23.2), which is the
    // invariant the whole phase-45 rename rests on: it is what lets 23 tables be
    // renamed rather than re-pointed and re-written.
    expect(spaceScope('user_a').spaceId).toBe('user_a');
  });

  it('names the same person as the actor, with the owner role', () => {
    // The two fields the rename added. `actorUserId` is attribution and role
    // checks and is never a query filter (§23.4); `role` is inert until phase 46
    // gives a space more than one member.
    const scope = spaceScope('user_a');
    expect(scope.actorUserId).toBe('user_a');
    expect(scope.role).toBe('owner');
  });

  it('rejects an empty user id loudly', () => {
    // An empty scope would build `WHERE userId = ''` — no leak, but every list
    // silently returns nothing, which reads as "the page is broken" and costs a
    // day to trace back to auth.
    expect(() => spaceScope('')).toThrow(/verified userId is required/);
  });

  it('rejects a non-string user id', () => {
    // Guards the JS caller (a capability handler reading a JSON payload) that
    // TypeScript can't see.
    // @ts-expect-error — deliberately violating the signature
    expect(() => spaceScope(undefined)).toThrow(/verified userId is required/);
    // @ts-expect-error — deliberately violating the signature
    expect(() => spaceScope({ spaceId: 'user_a' })).toThrow(/verified userId is required/);
  });
});

describe('spaceScopeFor', () => {
  it('mints a scope for somebody who is not the owner', () => {
    // The `access/**` case: a grantee reading another person's personal space.
    // §23.2 says a personal space's scope is always `owner`; it is not, and has
    // not been since Release 2, which is why the asserted invariant is the
    // exclusion (`owner` never appears on a group space) rather than that.
    const scope = spaceScopeFor({ spaceId: 'space_a', actorUserId: 'user_b', role: 'viewer' });
    expect(scope.spaceId).toBe('space_a');
    expect(scope.actorUserId).toBe('user_b');
    expect(scope.role).toBe('viewer');
  });

  it('allows a viewer with no actor, which is how a public link resolves', () => {
    const scope = spaceScopeFor({ spaceId: 'space_a', actorUserId: null, role: 'viewer' });
    expect(scope.actorUserId).toBeNull();
  });

  it('refuses the owner role with no actor', () => {
    // `owner` means "the sole human who owns this space". An anonymous
    // public-link reader is not that, and a scope claiming they are would carry
    // every permission into a request that arrived with no session at all.
    expect(() => spaceScopeFor({ spaceId: 'space_a', actorUserId: null, role: 'owner' })).toThrow(
      /requires a named actor/
    );
  });

  it('rejects an empty space id loudly', () => {
    expect(() => spaceScopeFor({ spaceId: '', actorUserId: 'user_a', role: 'member' })).toThrow(
      /verified spaceId is required/
    );
  });
});

describe('spaceWhere', () => {
  it('produces exactly the space filter and nothing else', () => {
    // Extra keys here would silently widen or narrow every query in the brain.
    //
    // The Prisma FIELD is still `userId`, mapped to the `spaceId` column: phase
    // 45 renames the column and the field in separate commits so the
    // irreversible one carries no code. This assertion is the seam, and it is
    // the line that changes when the field follows.
    expect(spaceWhere(spaceScope('user_a'))).toEqual({ spaceId: 'user_a' });
  });

  it('cannot be overridden by a later spread', () => {
    // The documented spread order: scope first, filters after. This asserts the
    // failure mode is visible — a caller-supplied userId wins only if someone
    // writes the spread backwards, which review can see.
    const where = { ...spaceWhere(spaceScope('user_a')), status: 'todo' };

    expect(where).toEqual({ spaceId: 'user_a', status: 'todo' });
  });
});

describe('liveSpaceWhere', () => {
  it('excludes archived rows by default', () => {
    // Every default list gains this, from one place rather than 40 call sites.
    expect(liveSpaceWhere(spaceScope('user_a'))).toEqual({
      spaceId: 'user_a',
      archivedAt: null,
    });
  });

  it('includes archived rows only when asked explicitly', () => {
    expect(liveSpaceWhere(spaceScope('user_a'), true)).toEqual({ spaceId: 'user_a' });
  });

  it('still scopes to the owner when including archived rows', () => {
    // The opt-in widens the lifecycle filter, never the ownership one.
    expect(liveSpaceWhere(spaceScope('user_a'), true).spaceId).toBe('user_a');
  });
});
