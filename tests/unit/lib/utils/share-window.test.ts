/**
 * Unit Tests: `isShareActive`, the one definition of "this share is still live".
 *
 * The predicate is four lines and it is the gate on two independent sharing
 * systems: admin conversation shares
 * (`lib/orchestration/access/conversation-access.ts`) and Resparkable's grants
 * and public links (`lib/framework/resparkable/access/**`). Both fail the same
 * way if it is wrong, and both fail *open*: a link its owner believed had
 * lapsed keeps serving, and nothing in the response says so.
 *
 * It is exercised transitively by the access suites, which is not the same as
 * being tested. Those assert what a caller concluded; this asserts the boundary
 * conditions the caller cannot see. Every case below is one of the mistakes the
 * source file's own header says the predicate exists to prevent.
 *
 * Test coverage:
 * - Revocation wins, whatever the clock says
 * - `expiresAt: null` means never expires, not "expired"
 * - The `<=` boundary: expiring exactly now has expired
 * - Both columns null is the live case
 * - `now` is injectable, so a batch resolves against one instant
 * - The old import site still re-exports the same function
 */

import { describe, expect, it } from 'vitest';

import { isShareActive, type ShareWindow } from '@/lib/utils/share-window';
import { isShareActive as reExported } from '@/lib/orchestration/access/conversation-access';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function share(overrides: Partial<ShareWindow> = {}): ShareWindow {
  return { revokedAt: null, expiresAt: null, ...overrides };
}

describe('isShareActive', () => {
  it('is live when neither column is set', () => {
    expect(isShareActive(share(), NOW)).toBe(true);
  });

  it('treats a null expiry as never expiring, not as expired', () => {
    // The mistake this guards: reading `null` as a missing date and comparing
    // it against the clock, which makes every never-expiring share dead.
    expect(isShareActive(share({ expiresAt: null }), NOW)).toBe(true);
  });

  it('is live while the expiry is in the future', () => {
    expect(isShareActive(share({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(true);
  });

  it('has expired at the exact boundary', () => {
    // `<=`, not `<`. A share expiring exactly now has expired.
    expect(isShareActive(share({ expiresAt: new Date(NOW.getTime()) }), NOW)).toBe(false);
  });

  it('has expired once the expiry is past', () => {
    expect(isShareActive(share({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
  });

  it('is dead when revoked, even with no expiry', () => {
    expect(isShareActive(share({ revokedAt: new Date(NOW.getTime() - 1000) }), NOW)).toBe(false);
  });

  it('is dead when revoked, even with an expiry far in the future', () => {
    // Revocation is the stronger statement: the owner said stop, and that
    // answer does not depend on a clock.
    const far = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(isShareActive(share({ revokedAt: NOW, expiresAt: far }), NOW)).toBe(false);
  });

  it('is dead when revoked in the future, because a revocation row is a revocation', () => {
    // `revokedAt` is not compared against the clock at all. A row exists or it
    // does not; a clock-compared revocation would let a clock skew resurrect a
    // link the owner had closed.
    expect(isShareActive(share({ revokedAt: new Date(NOW.getTime() + 1000) }), NOW)).toBe(false);
  });

  it('resolves a batch against one injected instant', () => {
    // The reason `now` is a parameter: two rows in one list must not be judged
    // by two different clocks, one of which ticked past an expiry mid-loop.
    const boundary = new Date(NOW.getTime());
    const rows = [share({ expiresAt: boundary }), share({ expiresAt: boundary })];
    expect(rows.map((row) => isShareActive(row, NOW))).toEqual([false, false]);
  });

  it('defaults `now` to the current time', () => {
    expect(isShareActive(share({ expiresAt: new Date(Date.now() + 60_000) }))).toBe(true);
    expect(isShareActive(share({ expiresAt: new Date(Date.now() - 60_000) }))).toBe(false);
  });

  it('is the same function the old conversation-access import site exports', () => {
    // The move left a re-export behind so existing callers keep working. If
    // that ever becomes a second copy, the two sharing systems can drift about
    // what "still live" means, which is the entire reason the file exists.
    expect(reExported).toBe(isShareActive);
  });
});
