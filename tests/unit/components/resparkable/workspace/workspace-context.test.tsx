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
  useWorkspace,
  WorkspaceProvider,
  type WorkspaceState,
} from '@/components/resparkable/workspace/workspace-context';
import {
  findLeaf,
  listLeaves,
  type LeafNode,
} from '@/lib/framework/resparkable/ui/workspace/split-tree';

const STORAGE_KEY = 'resparkable.workspace.v1';

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

  it('persists to localStorage under resparkable.workspace.v1', () => {
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
