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
  findLeaf,
  listLeaves,
  openTabInLeaf,
  reorderTab,
  resizeSplit,
  showLauncher,
  splitLeaf,
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
