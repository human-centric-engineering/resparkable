/**
 * Unit Tests: reading and writing the active workspace on a URL (phase 47).
 *
 * Small functions, and the assertions are about the edges rather than the
 * happy path, because the edges are where a workspace switcher leaks:
 *
 *   1. **Absence means personal**, and there is no second spelling of it. A
 *      magic `?space=personal` would be a value every reader has to know about.
 *   2. **A repeated param resolves to nothing**, not to the first value. Two
 *      answers to "which brain" is not a question with a default.
 *   3. **`withSpace` composes with a path that already has a query string**,
 *      because most of them do.
 *
 * @see lib/framework/resparkable/ui/active-space.ts
 */

import { describe, expect, it } from 'vitest';

import {
  readSpaceTarget,
  SPACE_PARAM,
  withSpace,
} from '@/lib/framework/resparkable/ui/active-space';

describe('withSpace', () => {
  it('leaves the path untouched for the personal space', () => {
    // Personal is expressed by absence. A URL with no `?space=` is the URL the
    // app has always had, which is what keeps every existing bookmark working.
    expect(withSpace('/resparkable/today', null)).toBe('/resparkable/today');
    expect(withSpace('/resparkable/today', undefined)).toBe('/resparkable/today');
    expect(withSpace('/resparkable/today', '')).toBe('/resparkable/today');
  });

  it('appends with ? on a bare path and & on one that already asks something', () => {
    expect(withSpace('/resparkable/today', 'spc_1')).toBe('/resparkable/today?space=spc_1');
    expect(withSpace('/resparkable/plan?day=2026-09-03', 'spc_1')).toBe(
      '/resparkable/plan?day=2026-09-03&space=spc_1'
    );
  });

  it('encodes the value', () => {
    // Space ids are minted as `spc_<hex>` and cannot contain anything exotic,
    // so this is not defending against today's ids. It defends against the day
    // a fork mints something else and this function is the last thing anyone
    // thinks to check.
    expect(withSpace('/resparkable/today', 'a b&c')).toBe('/resparkable/today?space=a%20b%26c');
  });
});

describe('readSpaceTarget', () => {
  it('reads a single value from URLSearchParams', () => {
    expect(readSpaceTarget(new URLSearchParams('space=spc_1'))).toBe('spc_1');
  });

  it("reads a single value from a page's resolved searchParams object", () => {
    expect(readSpaceTarget({ space: 'spc_1' })).toBe('spc_1');
  });

  it('reads nothing from an absent, empty or whitespace param', () => {
    expect(readSpaceTarget(undefined)).toBeNull();
    expect(readSpaceTarget(new URLSearchParams(''))).toBeNull();
    expect(readSpaceTarget(new URLSearchParams('space='))).toBeNull();
    expect(readSpaceTarget({ space: '   ' })).toBeNull();
    expect(readSpaceTarget({ day: '2026-09-03' })).toBeNull();
  });

  it('reads nothing from a repeated param rather than picking one', () => {
    // `?space=a&space=b` is either a bug or an attempt. Choosing the first is a
    // coin toss whose losing side is a read against a space the caller did not
    // ask for; resolving to personal fails as a 404 on their own brain.
    expect(readSpaceTarget(new URLSearchParams('space=spc_1&space=spc_2'))).toBeNull();
    expect(readSpaceTarget({ space: ['spc_1', 'spc_2'] })).toBeNull();
  });

  it('round-trips with withSpace', () => {
    const path = withSpace('/api/v1/resparkable/today', 'spc_1');
    expect(readSpaceTarget(new URL(path, 'https://example.test').searchParams)).toBe('spc_1');
    expect(SPACE_PARAM).toBe('space');
  });
});
