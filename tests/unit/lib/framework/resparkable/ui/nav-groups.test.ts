/**
 * Unit Tests: the nav-groups registry.
 *
 * `resparkable-nav.test.tsx`'s "grouping" describe block already exercises
 * this same data through its re-export from `resparkable-nav.tsx` — this
 * file tests it directly at its own home instead, both so coverage
 * attributes to the file that actually owns the logic and so a future
 * caller that imports straight from here (the Workspace launcher already
 * does) has its own regression coverage independent of the rail component.
 *
 * @see lib/framework/resparkable/ui/nav-groups.ts
 */

import { describe, expect, it } from 'vitest';

import {
  RESPARKABLE_NAV_GROUPS,
  RESPARKABLE_NAV_ITEMS,
} from '@/lib/framework/resparkable/ui/nav-groups';

describe('RESPARKABLE_NAV_ITEMS', () => {
  it('is the flattened form of RESPARKABLE_NAV_GROUPS, and nothing else', () => {
    const flattened = RESPARKABLE_NAV_GROUPS.flatMap((group) => group.items);
    expect(RESPARKABLE_NAV_ITEMS).toEqual(flattened);
  });

  it('has no href repeated across groups — a section filed under two groups would light up twice', () => {
    const hrefs = RESPARKABLE_NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives every item a non-empty label and a real icon component', () => {
    for (const item of RESPARKABLE_NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      // Most icons are Lucide's `forwardRef` objects, but Ask Sparkey's is a
      // plain function component (`SparkIcon`) — both are valid React
      // component types, so this accepts either rather than assuming `object`.
      expect(['function', 'object']).toContain(typeof item.icon);
    }
  });

  it('marks Today as the only exact-match entry — every path starts with /resparkable', () => {
    const exactItems = RESPARKABLE_NAV_ITEMS.filter((item) => item.exact);
    expect(exactItems).toHaveLength(1);
    expect(exactItems[0]?.label).toBe('Today');
  });
});

describe('RESPARKABLE_NAV_GROUPS', () => {
  it('names four groups, in product order, each with at least one item', () => {
    expect(RESPARKABLE_NAV_GROUPS.map((group) => group.label)).toEqual([
      'Daily',
      'Organise',
      'Knowledge',
      'Manage',
    ]);
    for (const group of RESPARKABLE_NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});
