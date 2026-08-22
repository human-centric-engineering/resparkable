/**
 * Unit Tests: the Workspace pane tree.
 *
 * Every function here takes the tree and every id it needs as arguments, so
 * there is nothing to mock — each case builds a small tree by hand and
 * asserts the tree that comes back. Grouped by the invariant being defended,
 * the same reasoning `score.test.ts` uses: "dedupe works" and "closing never
 * leaves a hanging single-child split" are different guarantees, and a flat
 * list of assertions would hide which one broke.
 *
 * @see lib/framework/resparkable/ui/workspace/split-tree.ts
 */

import { describe, expect, it } from 'vitest';

import {
  activateTab,
  closeLeaf,
  closeTab,
  createLeaf,
  detachTab,
  extractTab,
  findLeaf,
  isPointInsideRect,
  listLeaves,
  openTabInLeaf,
  reorderTab,
  resizeSplit,
  setRouteTab,
  setTabParams,
  setTabTitle,
  showLauncher,
  splitLeaf,
  updateTab,
  type LeafNode,
  type PaneNode,
  type SplitNode,
} from '@/lib/framework/resparkable/ui/workspace/split-tree';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

function tab(id: string, overrides: Partial<TabState> = {}): TabState {
  return { id, kind: 'today', params: {}, source: 'launcher', ...overrides };
}

describe('createLeaf', () => {
  it('starts empty — a freshly split pane opens to the launcher, never a clone', () => {
    expect(createLeaf('a')).toEqual({
      kind: 'leaf',
      id: 'a',
      tabs: [],
      activeTabId: null,
      locked: false,
    });
  });
});

describe('findLeaf / listLeaves', () => {
  it('finds a leaf nested inside a split', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [createLeaf('a'), createLeaf('b')],
      sizes: [50, 50],
    };

    expect(findLeaf(root, 'b')).toEqual(createLeaf('b'));
    expect(findLeaf(root, 'missing')).toBeNull();
  });

  it('lists every leaf, left to right', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [createLeaf('a'), createLeaf('b')],
      sizes: [50, 50],
    };

    expect(listLeaves(root).map((leaf) => leaf.id)).toEqual(['a', 'b']);
  });
});

describe('openTabInLeaf — dedupe', () => {
  it('appends and activates a new tab', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    expect((root as LeafNode).tabs.map((t) => t.id)).toEqual(['t1']);
    expect((root as LeafNode).activeTabId).toBe('t1');
  });

  it('activates the existing tab instead of duplicating one with the same kind and params', () => {
    const opened = openTabInLeaf(
      openTabInLeaf(createLeaf('a'), 'a', tab('t1', { kind: 'project', params: { id: 'p1' } })),
      'a',
      tab('t2', { kind: 'project', params: { id: 'p1' } })
    ) as LeafNode;

    expect(opened.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(opened.activeTabId).toBe('t1');
  });

  it('does not dedupe two tabs of different kinds that share a param', () => {
    const opened = openTabInLeaf(
      openTabInLeaf(createLeaf('a'), 'a', tab('t1', { kind: 'project', params: { id: 'p1' } })),
      'a',
      tab('t2', { kind: 'entity', params: { id: 'p1' } })
    ) as LeafNode;

    expect(opened.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('leaves other leaves untouched', () => {
    const root: PaneNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [createLeaf('a'), createLeaf('b')],
      sizes: [50, 50],
    };

    const next = openTabInLeaf(root, 'a', tab('t1')) as SplitNode;
    expect((next.children[0] as LeafNode).tabs).toHaveLength(1);
    expect((next.children[1] as LeafNode).tabs).toHaveLength(0);
  });
});

describe('activateTab', () => {
  it('switches the active tab', () => {
    const root = openTabInLeaf(openTabInLeaf(createLeaf('a'), 'a', tab('t1')), 'a', tab('t2'));
    const next = activateTab(root, 'a', 't1') as LeafNode;
    expect(next.activeTabId).toBe('t1');
  });

  it('is a no-op for a tab that is not in the leaf', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    expect(activateTab(root, 'a', 'missing')).toEqual(root);
  });
});

describe('showLauncher', () => {
  it('clears activeTabId without touching the tabs array', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const next = showLauncher(root, 'a') as LeafNode;
    expect(next.activeTabId).toBeNull();
    expect(next.tabs).toEqual([tab('t1')]);
  });

  it('is a no-op for an already-empty leaf', () => {
    const root = createLeaf('a');
    expect(showLauncher(root, 'a')).toEqual(root);
  });
});

/** Tabs distinguished by `params.id`, so `openTabInLeaf`'s dedupe never merges them. */
function distinctTab(id: string): TabState {
  return tab(id, { params: { id } });
}

describe('closeTab — active-tab handoff', () => {
  function threeTabs(): PaneNode {
    return openTabInLeaf(
      openTabInLeaf(openTabInLeaf(createLeaf('a'), 'a', distinctTab('t1')), 'a', distinctTab('t2')),
      'a',
      distinctTab('t3')
    );
  }

  it('activates the tab to the right when closing the active middle tab', () => {
    const root = activateTab(threeTabs(), 'a', 't2');
    const next = closeTab(root, 'a', 't2') as LeafNode;
    expect(next.tabs.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(next.activeTabId).toBe('t3');
  });

  it('activates the tab to the left when closing the last (active) tab', () => {
    const next = closeTab(threeTabs(), 'a', 't3') as LeafNode;
    expect(next.activeTabId).toBe('t2');
  });

  it('leaves activeTabId alone when closing an inactive tab', () => {
    const root = activateTab(threeTabs(), 'a', 't3');
    const next = closeTab(root, 'a', 't1') as LeafNode;
    expect(next.activeTabId).toBe('t3');
  });

  it('leaves an empty leaf in the tree rather than removing it', () => {
    const oneTab = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const next = closeTab(oneTab, 'a', 't1') as LeafNode;
    expect(next).toEqual({ kind: 'leaf', id: 'a', tabs: [], activeTabId: null, locked: false });
  });
});

describe('extractTab', () => {
  it('removes the tab and returns it alongside the updated tree', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const { root: next, tab: removed } = extractTab(root, 'a', 't1');
    expect((next as LeafNode).tabs).toHaveLength(0);
    expect(removed).toEqual(tab('t1'));
  });

  it('returns the same active-tab handoff closeTab relies on', () => {
    const root = openTabInLeaf(
      openTabInLeaf(openTabInLeaf(createLeaf('a'), 'a', distinctTab('t1')), 'a', distinctTab('t2')),
      'a',
      distinctTab('t3')
    );
    const active = activateTab(root, 'a', 't2');
    const { root: next } = extractTab(active, 'a', 't2');
    expect((next as LeafNode).activeTabId).toBe('t3');
  });

  it('returns a null tab and the tree unchanged for an id that is not there', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const { root: next, tab: removed } = extractTab(root, 'a', 'missing');
    expect(next).toEqual(root);
    expect(removed).toBeNull();
  });
});

describe('detachTab', () => {
  it('extracts a launcher-sourced tab exactly like extractTab', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const { root: next, tab: removed } = detachTab(root, 'a', 't1');
    expect((next as LeafNode).tabs).toHaveLength(0);
    expect(removed).toEqual(tab('t1'));
  });

  it('refuses the tree’s source: route tab — tree unchanged, tab null', () => {
    const root = openTabInLeaf(createLeaf('a'), 'a', tab('t1', { source: 'route' }));
    const { root: next, tab: removed } = detachTab(root, 'a', 't1');
    expect(next).toEqual(root);
    expect(removed).toBeNull();
  });
});

describe('isPointInsideRect', () => {
  const rect = { left: 10, right: 20, top: 5, bottom: 15 };

  it('is true for a point inside the rect, edges included', () => {
    expect(isPointInsideRect({ x: 15, y: 10 }, rect)).toBe(true);
    expect(isPointInsideRect({ x: 10, y: 5 }, rect)).toBe(true);
    expect(isPointInsideRect({ x: 20, y: 15 }, rect)).toBe(true);
  });

  it('is false for a point outside any one edge', () => {
    expect(isPointInsideRect({ x: 9, y: 10 }, rect)).toBe(false);
    expect(isPointInsideRect({ x: 21, y: 10 }, rect)).toBe(false);
    expect(isPointInsideRect({ x: 15, y: 4 }, rect)).toBe(false);
    expect(isPointInsideRect({ x: 15, y: 16 }, rect)).toBe(false);
  });
});

describe('reorderTab', () => {
  it('moves a tab to a new index', () => {
    const root = openTabInLeaf(
      openTabInLeaf(openTabInLeaf(createLeaf('a'), 'a', distinctTab('t1')), 'a', distinctTab('t2')),
      'a',
      distinctTab('t3')
    );
    const next = reorderTab(root, 'a', 't1', 2) as LeafNode;
    expect(next.tabs.map((t) => t.id)).toEqual(['t2', 't3', 't1']);
  });

  it('clamps an out-of-range target index', () => {
    const root = openTabInLeaf(
      openTabInLeaf(createLeaf('a'), 'a', distinctTab('t1')),
      'a',
      distinctTab('t2')
    );
    const next = reorderTab(root, 'a', 't1', 99) as LeafNode;
    expect(next.tabs.map((t) => t.id)).toEqual(['t2', 't1']);
  });
});

describe('splitLeaf', () => {
  it('wraps the leaf in a split with an empty new sibling, sizes even', () => {
    const original = openTabInLeaf(createLeaf('a'), 'a', tab('t1'));
    const next = splitLeaf(original, 'a', 'split-1', 'b', 'vertical') as SplitNode;

    expect(next).toEqual({
      kind: 'split',
      id: 'split-1',
      direction: 'vertical',
      sizes: [50, 50],
      children: [
        { kind: 'leaf', id: 'a', tabs: [tab('t1')], activeTabId: 't1', locked: false },
        createLeaf('b'),
      ],
    });
  });

  it('gives the split and the original leaf distinct ids, so both stay independently addressable', () => {
    const next = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal') as SplitNode;
    expect(next.id).not.toBe((next.children[0] as LeafNode).id);
    expect(findLeaf(next, 'a')).not.toBeNull();
  });
});

describe('closeLeaf — collapsing', () => {
  it('never removes the last remaining pane in the whole tree', () => {
    const root = createLeaf('a');
    expect(closeLeaf(root, 'a')).toBe(root);
  });

  it('collapses a two-way split back into its surviving sibling', () => {
    const split = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal');
    const next = closeLeaf(split, 'b');
    expect(next).toEqual(createLeaf('a'));
  });

  it('collapses recursively up multiple levels', () => {
    // a | (b | c) — closing b should leave a | c, not a | (c alone in a split).
    const step1 = splitLeaf(createLeaf('a'), 'a', 'root-split', 'b', 'horizontal') as SplitNode;
    const step2 = splitLeaf(step1, 'b', 'inner-split', 'c', 'vertical');

    const next = closeLeaf(step2, 'b') as SplitNode;
    expect(next).toEqual({
      kind: 'split',
      id: 'root-split',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [createLeaf('a'), createLeaf('c')],
    });
  });

  it('is a no-op for an id not in the tree', () => {
    const split = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal');
    expect(closeLeaf(split, 'missing')).toEqual(split);
  });
});

describe('resizeSplit', () => {
  it('normalizes sizes to sum to 100', () => {
    const split = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal');
    const next = resizeSplit(split, 'split-1', [30, 10]) as SplitNode;
    expect(next.sizes).toEqual([75, 25]);
  });

  it('is a no-op when the size count does not match the child count', () => {
    const split = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal');
    expect(resizeSplit(split, 'split-1', [10, 20, 30])).toEqual(split);
  });

  it('is a no-op for a leaf id (only splits have sizes)', () => {
    const leaf = createLeaf('a');
    expect(resizeSplit(leaf, 'a', [100])).toEqual(leaf);
  });
});

describe('setRouteTab', () => {
  it('opens the tab in the fallback leaf when no route tab exists yet', () => {
    const root = createLeaf('a');
    const newTab = tab('today-1', { kind: 'today', source: 'route' });

    const result = setRouteTab(root, newTab, 'a');

    expect(result.leafId).toBe('a');
    const leaf = findLeaf(result.root, 'a') as LeafNode;
    expect(leaf.tabs).toEqual([newTab]);
    expect(leaf.activeTabId).toBe('today-1');
  });

  it('replaces the existing route tab in place — same id, new kind/params', () => {
    const withRoute = openTabInLeaf(
      createLeaf('a'),
      'a',
      tab('route-tab', { kind: 'today', source: 'route' })
    );

    const result = setRouteTab(
      withRoute,
      tab('irrelevant-fresh-id', { kind: 'inbox', source: 'route' }),
      'a'
    );

    const leaf = findLeaf(result.root, 'a') as LeafNode;
    // Same id as the tab it replaced — not the fresh id `newTab` carried in.
    expect(leaf.tabs).toEqual([tab('route-tab', { kind: 'inbox', source: 'route' })]);
    expect(leaf.activeTabId).toBe('route-tab');
  });

  it('finds the route tab wherever it sits in the tree, not just the target leaf', () => {
    const split = splitLeaf(createLeaf('a'), 'a', 'split-1', 'b', 'horizontal');
    const withRoute = openTabInLeaf(
      split,
      'a',
      tab('route-tab', { kind: 'today', source: 'route' })
    );

    // Fallback leaf is 'b', but the route tab actually lives in 'a' — it must
    // be replaced there, not opened fresh in 'b'.
    const result = setRouteTab(withRoute, tab('x', { kind: 'inbox', source: 'route' }), 'b');

    expect(result.leafId).toBe('a');
    const leafA = findLeaf(result.root, 'a') as LeafNode;
    const leafB = findLeaf(result.root, 'b') as LeafNode;
    expect(leafA.tabs).toEqual([tab('route-tab', { kind: 'inbox', source: 'route' })]);
    expect(leafB.tabs).toEqual([]);
  });

  it('reactivates the route tab if some other tab in its leaf was active', () => {
    const withRoute = openTabInLeaf(
      createLeaf('a'),
      'a',
      tab('route-tab', { kind: 'today', source: 'route' })
    );
    const withLauncherTab = openTabInLeaf(
      withRoute,
      'a',
      tab('launcher-tab', { kind: 'boards', source: 'launcher' })
    );
    expect((findLeaf(withLauncherTab, 'a') as LeafNode).activeTabId).toBe('launcher-tab');

    const result = setRouteTab(withLauncherTab, tab('x', { kind: 'inbox', source: 'route' }), 'a');

    expect((findLeaf(result.root, 'a') as LeafNode).activeTabId).toBe('route-tab');
  });

  it('leaves every other tab in the leaf untouched', () => {
    const withRoute = openTabInLeaf(
      createLeaf('a'),
      'a',
      tab('route-tab', { kind: 'today', source: 'route' })
    );
    const withLauncherTab = openTabInLeaf(
      withRoute,
      'a',
      tab('launcher-tab', { kind: 'boards', source: 'launcher' })
    );

    const result = setRouteTab(withLauncherTab, tab('x', { kind: 'inbox', source: 'route' }), 'a');

    const leaf = findLeaf(result.root, 'a') as LeafNode;
    expect(leaf.tabs).toContainEqual(tab('launcher-tab', { kind: 'boards', source: 'launcher' }));
  });
});

describe('updateTab / setTabParams / setTabTitle — keyed on the tab, not the leaf', () => {
  function twoLeafTree(): SplitNode {
    return {
      kind: 'split',
      id: 's',
      direction: 'horizontal',
      children: [
        { kind: 'leaf', id: 'a', tabs: [tab('t1')], activeTabId: 't1', locked: false },
        {
          kind: 'leaf',
          id: 'b',
          tabs: [tab('t2', { kind: 'plan' }), tab('t3', { kind: 'project', params: { id: 'p1' } })],
          activeTabId: 't2',
          locked: false,
        },
      ],
      sizes: [50, 50],
    };
  }

  it('finds a tab in a nested leaf without being told which leaf it is in', () => {
    const next = setTabTitle(twoLeafTree(), 't3', 'Q3 Roadmap');

    const leaf = findLeaf(next, 'b') as LeafNode;
    expect(leaf.tabs[1].title).toBe('Q3 Roadmap');
  });

  it('merges params rather than replacing them, so a tab keeps what identifies it', () => {
    const next = setTabParams(twoLeafTree(), 't3', { status: 'paused' });

    const leaf = findLeaf(next, 'b') as LeafNode;
    expect(leaf.tabs[1].params).toEqual({ id: 'p1', status: 'paused' });
  });

  it('leaves every other tab in the tree untouched', () => {
    const before = twoLeafTree();
    const next = setTabParams(before, 't2', { day: '2026-01-02' });

    const leafA = findLeaf(next, 'a') as LeafNode;
    const leafB = findLeaf(next, 'b') as LeafNode;
    expect(leafA.tabs[0]).toEqual(tab('t1'));
    expect(leafB.tabs[1].params).toEqual({ id: 'p1' });
  });

  it('returns the same tree object when the tab is gone — a write racing a close is a no-op', () => {
    const before = twoLeafTree();

    expect(setTabParams(before, 'nope', { day: '2026-01-02' })).toBe(before);
  });

  it('returns the same tree object when the title is already what it would be set to', () => {
    const titled = setTabTitle(twoLeafTree(), 't3', 'Q3 Roadmap');

    // Identity, not deep equality: `workspace-context.tsx` compares
    // identities to skip a localStorage write and a re-render of every pane,
    // and `useTabTitle` writes on every render of a loaded detail tab.
    expect(setTabTitle(titled, 't3', 'Q3 Roadmap')).toBe(titled);
  });

  it('does not rebuild untouched split branches', () => {
    const before = twoLeafTree();
    const next = updateTab(before, 't1', (t) => ({ ...t, title: 'Today' })) as SplitNode;

    expect(next).not.toBe(before);
    expect(next.children[1]).toBe(before.children[1]);
  });
});

describe('openTabInLeaf — dedupe across the filter params', () => {
  it('treats two Plan tabs on different days as different tabs', () => {
    const leaf = createLeaf('a');
    const withMonday = openTabInLeaf(
      leaf,
      'a',
      tab('t1', { kind: 'plan', params: { day: '2026-01-05' } })
    );
    const withTuesday = openTabInLeaf(
      withMonday,
      'a',
      tab('t2', { kind: 'plan', params: { day: '2026-01-06' } })
    );

    expect((withTuesday as LeafNode).tabs).toHaveLength(2);
  });

  it('still dedupes two Plan tabs on the same day', () => {
    const leaf = createLeaf('a');
    const first = openTabInLeaf(
      leaf,
      'a',
      tab('t1', { kind: 'plan', params: { day: '2026-01-05' } })
    );
    const second = openTabInLeaf(
      first,
      'a',
      tab('t2', { kind: 'plan', params: { day: '2026-01-05' } })
    );

    expect((second as LeafNode).tabs).toHaveLength(1);
    expect((second as LeafNode).activeTabId).toBe('t1');
  });

  it('distinguishes a Search tab that includes the archive from one that does not', () => {
    const leaf = createLeaf('a');
    const plain = openTabInLeaf(leaf, 'a', tab('t1', { kind: 'search', params: { query: 'x' } }));
    const archived = openTabInLeaf(
      plain,
      'a',
      tab('t2', { kind: 'search', params: { query: 'x', includeArchived: true } })
    );

    expect((archived as LeafNode).tabs).toHaveLength(2);
  });
});
