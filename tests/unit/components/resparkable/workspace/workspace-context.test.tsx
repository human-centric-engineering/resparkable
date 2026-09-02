// @vitest-environment happy-dom

/**
 * Unit Tests: WorkspaceProvider / useWorkspace.
 *
 * `split-tree.test.ts` already covers every tree invariant in isolation;
 * these tests cover the thin, stateful layer this file adds on top of it —
 * localStorage persistence under the right key, id generation for new
 * leaves/tabs, and `focusedLeafId` bookkeeping (targeting it, following a
 * split, falling back off it when the focused leaf is closed).
 *
 * @see components/resparkable/workspace/workspace-context.tsx
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  useOptionalWorkspace,
  useWorkspace,
  WorkspaceProvider,
  type WorkspaceState,
} from '@/components/resparkable/workspace/workspace-context';
import {
  findLeaf,
  listLeaves,
  type LeafNode,
} from '@/lib/framework/resparkable/ui/workspace/split-tree';

const STORAGE_KEY = 'resparkable.workspace.v2';

function renderWorkspace() {
  return renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
}

function storedState(): WorkspaceState {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useWorkspace outside a provider', () => {
  it('throws rather than returning undefined context', () => {
    // renderHook swallows the render error internally and rethrows on
    // `.result.current` access — asserting via a wrapper-less render call.
    expect(() => renderHook(() => useWorkspace())).toThrow(
      'useWorkspace must be used within a WorkspaceProvider'
    );
  });
});

describe('useOptionalWorkspace', () => {
  // The throwing hook is the right default: it catches a pane component
  // rendered somewhere it cannot work. This one exists for the components that
  // genuinely render both inside the shell and on a plain page — `WorkspaceLink`
  // is why it was added, and "no workspace" is a real answer for it, not a bug.
  it('returns null outside a provider instead of throwing', () => {
    const { result } = renderHook(() => useOptionalWorkspace());

    expect(result.current).toBeNull();
  });

  it('returns the same context as useWorkspace inside a provider', () => {
    const { result } = renderHook(
      () => ({ optional: useOptionalWorkspace(), required: useWorkspace() }),
      { wrapper: WorkspaceProvider }
    );

    expect(result.current.optional).toBe(result.current.required);
  });
});

describe('initial state', () => {
  it('starts with one empty root leaf, focused', () => {
    const { result } = renderWorkspace();
    expect(result.current.root).toEqual({
      kind: 'leaf',
      id: 'root',
      tabs: [],
      activeTabId: null,
      locked: false,
    });
    expect(result.current.focusedLeafId).toBe('root');
  });
});

describe('openTab', () => {
  it('opens a tab in the focused leaf and activates it', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('today');
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs).toHaveLength(1);
    expect(leaf.tabs[0]).toMatchObject({ kind: 'today', params: {}, source: 'launcher' });
    expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
  });

  it('defaults source to launcher and honors an explicit route source', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('inbox');
      result.current.openTab('projects', {}, { source: 'route' });
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs.find((tab) => tab.kind === 'inbox')?.source).toBe('launcher');
    expect(leaf.tabs.find((tab) => tab.kind === 'projects')?.source).toBe('route');
  });

  it('dedupes a second open of the same kind and params', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('project', { id: 'clx1' });
    });
    act(() => {
      result.current.openTab('project', { id: 'clx1' });
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs).toHaveLength(1);
  });

  it('opens into a fresh split when newSplit is given, and focuses the new pane', () => {
    const { result } = renderWorkspace();
    const originalLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('graph', {}, { newSplit: 'vertical' });
    });

    expect(result.current.focusedLeafId).not.toBe(originalLeafId);
    expect(result.current.root.kind).toBe('split');
    expect(listLeaves(result.current.root)).toHaveLength(2);

    const newLeaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(newLeaf.tabs).toHaveLength(1);
    expect(newLeaf.tabs[0].kind).toBe('graph');
  });

  it('persists to localStorage under resparkable.workspace.v2', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('today');
    });

    expect(storedState().focusedLeafId).toBe(result.current.focusedLeafId);
  });
});

describe('splitLeaf / closeLeaf', () => {
  it('splitLeaf focuses the new empty sibling, not the original pane', () => {
    const { result } = renderWorkspace();
    const originalLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.splitLeaf(originalLeafId, 'horizontal');
    });

    expect(result.current.focusedLeafId).not.toBe(originalLeafId);
    expect(findLeaf(result.current.root, originalLeafId)).not.toBeNull();
  });

  it('falls back focus to a remaining leaf when the focused leaf is closed', () => {
    const { result } = renderWorkspace();
    const originalLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.splitLeaf(originalLeafId, 'horizontal');
    });
    const splitLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.closeLeaf(splitLeafId);
    });

    expect(result.current.focusedLeafId).toBe(originalLeafId);
    expect(findLeaf(result.current.root, splitLeafId)).toBeNull();
  });

  it('never closes the last remaining pane', () => {
    const { result } = renderWorkspace();
    const onlyLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.closeLeaf(onlyLeafId);
    });

    expect(result.current.root).toEqual({
      kind: 'leaf',
      id: onlyLeafId,
      tabs: [],
      activeTabId: null,
      locked: false,
    });
  });
});

describe('floating panels', () => {
  it('starts with no floating panels', () => {
    const { result } = renderWorkspace();
    expect(result.current.floatingPanels).toEqual([]);
  });

  it('detachTab moves a tab out of its leaf and into floatingPanels', () => {
    const { result } = renderWorkspace();
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('inbox');
    });
    const tabId = (findLeaf(result.current.root, leafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(leafId, tabId, { x: 40, y: 60 });
    });

    expect((findLeaf(result.current.root, leafId) as LeafNode).tabs).toHaveLength(0);
    expect(result.current.floatingPanels).toHaveLength(1);
    expect(result.current.floatingPanels[0]).toMatchObject({
      tab: { id: tabId, kind: 'inbox' },
      originLeafId: leafId,
      x: 40,
      y: 60,
    });
  });

  it('detachTab is a no-op for the tree’s source: route tab', () => {
    const { result } = renderWorkspace();
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.syncRouteTab('today');
    });
    const tabId = (findLeaf(result.current.root, leafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(leafId, tabId, { x: 0, y: 0 });
    });

    expect((findLeaf(result.current.root, leafId) as LeafNode).tabs).toHaveLength(1);
    expect(result.current.floatingPanels).toHaveLength(0);
  });

  it('dockPanel appends the panel’s tab into the target leaf, activates it, and focuses that leaf', () => {
    const { result } = renderWorkspace();
    const originLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('inbox');
      result.current.splitLeaf(originLeafId, 'horizontal');
    });
    const targetLeafId = result.current.focusedLeafId;
    const tabId = (findLeaf(result.current.root, originLeafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(originLeafId, tabId, { x: 0, y: 0 });
    });
    const panelId = result.current.floatingPanels[0].id;

    act(() => {
      result.current.dockPanel(panelId, targetLeafId);
    });

    const targetLeaf = findLeaf(result.current.root, targetLeafId) as LeafNode;
    expect(targetLeaf.tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(targetLeaf.activeTabId).toBe(tabId);
    expect(result.current.focusedLeafId).toBe(targetLeafId);
    expect(result.current.floatingPanels).toHaveLength(0);
  });

  it('dockPanel dedupes into an existing tab of the same kind and params, same as openTabInLeaf', () => {
    const { result } = renderWorkspace();
    const originLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('project', { id: 'clx1' });
      result.current.splitLeaf(originLeafId, 'horizontal');
    });
    const targetLeafId = result.current.focusedLeafId;
    const originalTabId = (findLeaf(result.current.root, originLeafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(originLeafId, originalTabId, { x: 0, y: 0 });
    });
    const panelId = result.current.floatingPanels[0].id;

    act(() => {
      result.current.openTab('project', { id: 'clx1' });
    });
    const existingTabId = (findLeaf(result.current.root, targetLeafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.dockPanel(panelId, targetLeafId);
    });

    const targetLeaf = findLeaf(result.current.root, targetLeafId) as LeafNode;
    expect(targetLeaf.tabs.map((tab) => tab.id)).toEqual([existingTabId]);
  });

  it('moveFloatingPanel/resizeFloatingPanel update only the target panel', () => {
    const { result } = renderWorkspace();
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('inbox');
    });
    const tabId = (findLeaf(result.current.root, leafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(leafId, tabId, { x: 0, y: 0 });
    });
    const panelId = result.current.floatingPanels[0].id;

    act(() => {
      result.current.moveFloatingPanel(panelId, 120, 80);
      result.current.resizeFloatingPanel(panelId, 500, 400);
    });

    expect(result.current.floatingPanels[0]).toMatchObject({
      x: 120,
      y: 80,
      width: 500,
      height: 400,
    });
  });

  it('closeFloatingPanel discards the panel without touching the pane tree', () => {
    const { result } = renderWorkspace();
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('inbox');
    });
    const tabId = (findLeaf(result.current.root, leafId) as LeafNode).tabs[0].id;

    act(() => {
      result.current.detachTab(leafId, tabId, { x: 0, y: 0 });
    });
    const panelId = result.current.floatingPanels[0].id;

    act(() => {
      result.current.closeFloatingPanel(panelId);
    });

    expect(result.current.floatingPanels).toHaveLength(0);
    expect((findLeaf(result.current.root, leafId) as LeafNode).tabs).toHaveLength(0);
  });

  it('focusFloatingPanel brings the target panel to the front of the paint order', () => {
    const { result } = renderWorkspace();
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.openTab('inbox');
      result.current.openTab('projects');
    });
    const leaf = findLeaf(result.current.root, leafId) as LeafNode;

    act(() => {
      result.current.detachTab(leafId, leaf.tabs[0].id, { x: 0, y: 0 });
      result.current.detachTab(leafId, leaf.tabs[1].id, { x: 0, y: 0 });
    });
    const [first, second] = result.current.floatingPanels;

    act(() => {
      result.current.focusFloatingPanel(first.id);
    });

    const refreshed = result.current.floatingPanels;
    const refreshedFirst = refreshed.find((panel) => panel.id === first.id)!;
    const refreshedSecond = refreshed.find((panel) => panel.id === second.id)!;
    expect(refreshedFirst.z).toBeGreaterThan(refreshedSecond.z);
  });
});

describe('focusLeaf', () => {
  it('moves focus to an existing leaf', () => {
    const { result } = renderWorkspace();
    const originalLeafId = result.current.focusedLeafId;

    act(() => {
      result.current.splitLeaf(originalLeafId, 'horizontal');
    });
    act(() => {
      result.current.focusLeaf(originalLeafId);
    });

    expect(result.current.focusedLeafId).toBe(originalLeafId);
  });

  it('is a no-op for an id that is not in the tree', () => {
    const { result } = renderWorkspace();
    const before = result.current.focusedLeafId;

    act(() => {
      result.current.focusLeaf('does-not-exist');
    });

    expect(result.current.focusedLeafId).toBe(before);
  });
});

describe('syncRouteTab', () => {
  it('opens a route-sourced tab in the focused leaf on first sync', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.syncRouteTab('today');
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs).toMatchObject([{ kind: 'today', params: {}, source: 'route' }]);
    expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
  });

  it('replaces the existing route tab rather than opening a second one', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.syncRouteTab('today');
    });
    const routeTabId = (findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode)
      .tabs[0].id;

    act(() => {
      result.current.syncRouteTab('inbox');
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs).toHaveLength(1);
    expect(leaf.tabs[0]).toMatchObject({ id: routeTabId, kind: 'inbox', source: 'route' });
  });

  it('leaves launcher-opened tabs in the same leaf alone', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('boards');
      result.current.syncRouteTab('today');
      result.current.syncRouteTab('inbox');
    });

    const leaf = findLeaf(result.current.root, result.current.focusedLeafId) as LeafNode;
    expect(leaf.tabs.map((tab) => tab.kind).sort()).toEqual(['boards', 'inbox']);
  });
});

describe('showLauncher', () => {
  it('clears the active tab without closing it, so the launcher shows over open tabs', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.openTab('today');
    });
    const leafId = result.current.focusedLeafId;

    act(() => {
      result.current.showLauncher(leafId);
    });

    const leaf = findLeaf(result.current.root, leafId) as LeafNode;
    expect(leaf.activeTabId).toBeNull();
    expect(leaf.tabs).toHaveLength(1);
  });
});
