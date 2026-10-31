/**
 * Unit Tests: the one rule for matching a person by email address (phase 66).
 *
 * Access, both accept flows, subject export, erasure and grant-time account
 * binding all call `matchableAddress`, so these cases are the rule for all of
 * them. Each reader's own test pins that it calls it.
 *
 * @see lib/framework/resparkable/privacy/address.ts
 */

import { describe, expect, it } from 'vitest';

import { matchableAddress } from '@/lib/framework/resparkable/privacy/address';

describe('matchableAddress', () => {
  it('gives the trimmed, lower-cased address of a verified account', () => {
    // Writers store addresses lower-cased; a `User.email` is whatever the
    // account was created with. Matching raw would miss anybody who signed up
    // with a capital letter.
    expect(matchableAddress({ email: ' Bob@Example.COM ', emailVerified: true })).toBe(
      'bob@example.com'
    );
  });

  it('gives null for an account that has not verified its address', () => {
    // With verification off, anybody can sign up under somebody else's address.
    expect(matchableAddress({ email: 'bob@example.com', emailVerified: false })).toBeNull();
  });

  it('gives null for no address, or one that is only whitespace', () => {
    // An empty string must never reach a `where`: it would match every row
    // stored with an empty address.
    expect(matchableAddress({ email: null, emailVerified: true })).toBeNull();
    expect(matchableAddress({ email: undefined, emailVerified: true })).toBeNull();
    expect(matchableAddress({ email: '   ', emailVerified: true })).toBeNull();
  });
});
