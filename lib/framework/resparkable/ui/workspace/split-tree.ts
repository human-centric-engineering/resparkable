/**
 * The Workspace pane tree — pure, framework-agnostic, and the one thing
 * `WorkspacePaneTree` (Phase 2) walks to render nested `ResizablePanelGroup`s.
 *
 * A pane is either a `leaf` (a strip of tabs, one active) or a `split` (two
 * or more children laid out along one axis). A split's children can be
 * leaves or further splits — that recursion is what makes "split a pane
 * that's already split" arbitrarily deep for free, and it is the entire
 * reason this is a tree and not a fixed three-pane record.
 *
 * Two properties this file exists to guarantee, in the same spirit as
 * `priority/score.ts`:
 *
 *   1. **It does no I/O and owns no ids.** Every `id` a function needs (a new
 *      leaf's id, a new tab's id) arrives as an argument. That is what makes
 *      "does this dedupe correctly" a table test instead of a mocking
 *      exercise, and it is why `workspace-context.tsx` — the one place that
 *      is allowed to call `crypto.randomUUID()` — can stay a thin wrapper.
 *   2. **A tree is never left with a hanging single-child split.** Closing
 *      the second-to-last tab out of a two-way split's pane collapses that
 *      split back into its surviving sibling, recursively up the tree. A
 *      `split` node in this module's output always has at least two
 *      children; nothing downstream has to defend against one that doesn't.
 *
 * `sizes` are percentages of the split's own axis, summing to 100 — the unit
 * `react-resizable-panels`' `defaultSize` prop expects directly.
 */

import type { TabParams, TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export type SplitDirection = 'horizontal' | 'vertical';

export interface LeafNode {
  kind: 'leaf';
  id: string;
  tabs: TabState[];
  activeTabId: string | null;
  /** A pane the user has pinned open — Present mode locks the deck pane (Phase 7). */
  locked: boolean;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: SplitDirection;
  children: PaneNode[];
  /** Percentages along `direction`'s axis, one per child, summing to 100. */
  sizes: number[];
}

export type PaneNode = LeafNode | SplitNode;

/** A freshly created, empty leaf — opens to the launcher, never a clone of its sibling. */
export function createLeaf(id: string): LeafNode {
  return { kind: 'leaf', id, tabs: [], activeTabId: null, locked: false };
}

/** The leaf with this id, wherever it sits in the tree, or `null`. */
export function findLeaf(root: PaneNode, leafId: string): LeafNode | null {
  if (root.kind === 'leaf') return root.id === leafId ? root : null;
  for (const child of root.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

/** Every leaf in the tree, left to right / top to bottom. */
export function listLeaves(root: PaneNode): LeafNode[] {
  if (root.kind === 'leaf') return [root];
  return root.children.flatMap(listLeaves);
}

/** Applies `fn` to the node with `id` (leaf or split), leaving the rest of the tree untouched. */
function mapNode(root: PaneNode, id: string, fn: (node: PaneNode) => PaneNode): PaneNode {
  if (root.id === id) return fn(root);
  if (root.kind === 'leaf') return root;
  return { ...root, children: root.children.map((child) => mapNode(child, id, fn)) };
}

function sameParams(a: TabParams, b: TabParams): boolean {
  return (
    a.id === b.id &&
    a.slug === b.slug &&
    a.query === b.query &&
    a.focusType === b.focusType &&
    a.focus === b.focus
  );
}

/** Two tabs are "identical" for dedupe purposes when their kind and params match. */
function sameTab(
  a: Pick<TabState, 'kind' | 'params'>,
  b: Pick<TabState, 'kind' | 'params'>
): boolean {
  return a.kind === b.kind && sameParams(a.params, b.params);
}

/**
 * Opens `tab` in the leaf `leafId`.
 *
 * If that leaf already holds a tab of the same kind and params, `tab` is
 * discarded and the existing one is activated instead — this is the dedupe
 * the build plan's `openTab()` cross-pane action relies on, kept here as a
 * pure, independently testable tree invariant rather than a check the
 * caller has to remember to run first.
 */
export function openTabInLeaf(root: PaneNode, leafId: string, tab: TabState): PaneNode {
  return mapNode(root, leafId, (node) => {
    if (node.kind !== 'leaf') return node;
    const existing = node.tabs.find((candidate) => sameTab(candidate, tab));
    if (existing) return { ...node, activeTabId: existing.id };
    return { ...node, tabs: [...node.tabs, tab], activeTabId: tab.id };
  });
}

/** Makes `tabId` the active tab of leaf `leafId`. No-op if the tab isn't there. */
export function activateTab(root: PaneNode, leafId: string, tabId: string): PaneNode {
  return mapNode(root, leafId, (node) => {
    if (node.kind !== 'leaf') return node;
    if (!node.tabs.some((tab) => tab.id === tabId)) return node;
    return { ...node, activeTabId: tabId };
  });
}

/**
 * Shows the launcher in leaf `leafId` without closing any of its tabs — the
 * "+" affordance for opening something new in a pane that already has tabs.
 * Leaves `tabs` untouched; a pane renders its launcher exactly when
 * `activeTabId` is `null`, whether that's because it has no tabs at all or
 * because this was called.
 */
export function showLauncher(root: PaneNode, leafId: string): PaneNode {
  return mapNode(root, leafId, (node) =>
    node.kind === 'leaf' ? { ...node, activeTabId: null } : node
  );
}

/**
 * Closes `tabId` out of leaf `leafId`. If it was the active tab, the tab to
 * its right becomes active, or its left if it was the last one — so closing
 * never jumps focus across the strip. An empty leaf is left in place (it
 * renders the launcher); it is only ever removed from the tree by
 * `closeLeaf`.
 */
export function closeTab(root: PaneNode, leafId: string, tabId: string): PaneNode {
  return mapNode(root, leafId, (node) => {
    if (node.kind !== 'leaf') return node;
    const index = node.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return node;

    const tabs = [...node.tabs.slice(0, index), ...node.tabs.slice(index + 1)];
    if (node.activeTabId !== tabId) return { ...node, tabs };

    const nextActive = tabs[index] ?? tabs[index - 1] ?? null;
    return { ...node, tabs, activeTabId: nextActive?.id ?? null };
  });
}

/** Moves `tabId` to `toIndex` within leaf `leafId`'s tab strip. */
export function reorderTab(
  root: PaneNode,
  leafId: string,
  tabId: string,
  toIndex: number
): PaneNode {
  return mapNode(root, leafId, (node) => {
    if (node.kind !== 'leaf') return node;
    const fromIndex = node.tabs.findIndex((tab) => tab.id === tabId);
    if (fromIndex === -1) return node;

    // Clamp against the length BEFORE removal: `toIndex` is a position in the
    // final, same-length array, and clamping against the post-splice length
    // would make "move to the end" fall one short.
    const clamped = clampIndex(toIndex, node.tabs.length);
    const tabs = [...node.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(clamped, 0, moved);
    return { ...node, tabs };
  });
}

/**
 * Splits leaf `leafId` in two along `direction`. The original leaf keeps
 * its id, tabs and active tab, and moves to the first child, unchanged;
 * `newLeafId` becomes an empty sibling opening to the launcher, never a
 * clone. Sizes start even.
 *
 * Takes a separate `newSplitId` for the wrapping `split` node — reusing
 * `leafId` there would leave two nodes in the tree sharing an id (the split
 * and its own first child), which breaks every lookup by id in this file.
 *
 * Always nests a new `split` node in place of the target leaf, even when
 * the parent already splits the same way — flattening same-direction
 * splits is a worthwhile follow-up, not required for arbitrarily deep
 * splitting to work correctly now.
 */
export function splitLeaf(
  root: PaneNode,
  leafId: string,
  newSplitId: string,
  newLeafId: string,
  direction: SplitDirection
): PaneNode {
  return mapNode(root, leafId, (node): PaneNode => {
    if (node.kind !== 'leaf') return node;
    return {
      kind: 'split',
      id: newSplitId,
      direction,
      children: [node, createLeaf(newLeafId)],
      sizes: [50, 50],
    };
  });
}

/**
 * Removes leaf `leafId` from the tree entirely. If its parent split is left
 * with one child, that child takes the split's place — recursively, so
 * closing a leaf three levels deep never leaves a chain of single-child
 * splits behind. The root leaf (the last pane in the whole tree) is never
 * removed; closing it is a no-op, matching `splitLeaf`'s "always at least
 * one pane" invariant.
 */
export function closeLeaf(root: PaneNode, leafId: string): PaneNode {
  if (root.kind === 'leaf') return root;
  return removeNode(root, leafId) ?? root;
}

function removeNode(node: PaneNode, targetId: string): PaneNode | null {
  if (node.kind === 'leaf') {
    return node.id === targetId ? null : node;
  }

  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const result = removeNode(child, targetId);
    if (result !== null) {
      children.push(result);
      sizes.push(node.sizes[index] ?? 0);
    }
  });

  // No early-out for "same child count as before": a child can come back
  // *changed* (its own subtree collapsed a level) without the count at
  // *this* level changing, and that change still has to propagate up.
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // collapse the now-single-child split
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

/**
 * Finds the tree's one `source: 'route'` tab, wherever it sits. There is
 * ever at most one — see `setRouteTab`'s own header comment.
 */
function findRouteTab(root: PaneNode): { leafId: string; tabId: string } | null {
  for (const leaf of listLeaves(root)) {
    const tab = leaf.tabs.find((candidate) => candidate.source === 'route');
    if (tab) return { leafId: leaf.id, tabId: tab.id };
  }
  return null;
}

/**
 * Syncs the tree's single route-backed tab to `newTab` — the pure half of
 * `route-tab-bridge.tsx` (Phase 8). "Only one route-sourced tab exists at a
 * time" (the build plan's own words) means a fresh navigation must *replace*
 * whichever tab currently carries `source: 'route'`, not open a second one
 * next to it the way a plain `openTabInLeaf` dedupe-by-kind-and-params would
 * on a route whose kind/params changed. Replacing keeps that tab's id and
 * position in its leaf's strip, and makes it that leaf's active tab.
 *
 * When no route tab exists yet — the very first load, or after the user
 * closed it and it hasn't reappeared — `newTab` opens in `fallbackLeafId`
 * instead, via the normal `openTabInLeaf` (so a launcher tab of the same
 * kind/params there is still deduped against rather than doubled).
 */
export function setRouteTab(
  root: PaneNode,
  newTab: TabState,
  fallbackLeafId: string
): { root: PaneNode; leafId: string } {
  const existing = findRouteTab(root);
  if (!existing) {
    return { root: openTabInLeaf(root, fallbackLeafId, newTab), leafId: fallbackLeafId };
  }

  const { leafId, tabId } = existing;
  const updated = mapNode(root, leafId, (node) => {
    if (node.kind !== 'leaf') return node;
    return {
      ...node,
      tabs: node.tabs.map((tab) => (tab.id === tabId ? { ...newTab, id: tab.id } : tab)),
      activeTabId: tabId,
    };
  });
  return { root: updated, leafId };
}

/** Sets the sizes of split `splitId`'s children. Ignored (returns the tree unchanged) if the count doesn't match. */
export function resizeSplit(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  return mapNode(root, splitId, (node) => {
    if (node.kind !== 'split' || sizes.length !== node.children.length) return node;
    return { ...node, sizes: normalizeSizes(sizes) };
  });
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((size) => (size / total) * 100);
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}
