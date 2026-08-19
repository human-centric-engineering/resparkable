'use client';

/**
 * WorkspaceProvider — the one context every pane of the new shell reads and
 * writes through, per the build plan's "one `WorkspaceProvider`, a pure
 * split-tree, no event bus" decision.
 *
 * All the actual tree logic lives in `split-tree.ts`, which is pure and
 * owns no ids. This file is what's allowed to be impure: it calls
 * `crypto.randomUUID()` for new leaf/tab ids, persists the result via the
 * existing `useLocalStorage` hook under `resparkable.workspace.v1`, and
 * exposes one function per user action as a stable callback. Sparkey's
 * composer and the Activity pane call `useWorkspace().openTab(...)`
 * directly to cross-open a tab — no custom events, because they already
 * sit inside the same provider.
 *
 * `focusedLeafId` names the pane cross-pane actions and unsplit opens
 * target. Whenever a mutation could remove the focused leaf (`closeLeaf`),
 * focus falls back to the tree's first remaining leaf rather than pointing
 * at an id that no longer exists.
 */

import * as React from 'react';

import {
  activateTab as activateTabInTree,
  closeLeaf as closeLeafInTree,
  closeTab as closeTabInTree,
  createLeaf,
  findLeaf,
  listLeaves,
  openTabInLeaf,
  reorderTab as reorderTabInTree,
  resizeSplit as resizeSplitInTree,
  splitLeaf as splitLeafInTree,
  type PaneNode,
  type SplitDirection,
} from '@/lib/framework/resparkable/ui/workspace/split-tree';
import type {
  TabKind,
  TabParams,
  TabSource,
  TabState,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

const STORAGE_KEY = 'resparkable.workspace.v1';

/** The one leaf that exists before anything is ever opened. Never removed — see `closeLeaf`'s guarantee. */
const ROOT_LEAF_ID = 'root';

export interface WorkspaceState {
  root: PaneNode;
  focusedLeafId: string;
}

const DEFAULT_STATE: WorkspaceState = {
  root: createLeaf(ROOT_LEAF_ID),
  focusedLeafId: ROOT_LEAF_ID,
};

export interface OpenTabOptions {
  /** Opens in a fresh split off the focused pane instead of in it. */
  newSplit?: SplitDirection;
  /** Defaults to `'launcher'` — `route-tab-bridge.tsx` (Phase 8) passes `'route'` explicitly. */
  source?: TabSource;
}

export interface WorkspaceContextValue {
  root: PaneNode;
  focusedLeafId: string;
  /** Opens (or focuses, if already open) a tab in the focused pane. */
  openTab: (kind: TabKind, params?: TabParams, opts?: OpenTabOptions) => void;
  closeTab: (leafId: string, tabId: string) => void;
  activateTab: (leafId: string, tabId: string) => void;
  reorderTab: (leafId: string, tabId: string, toIndex: number) => void;
  /** Splits `leafId` and focuses the new, empty sibling pane. */
  splitLeaf: (leafId: string, direction: SplitDirection) => void;
  closeLeaf: (leafId: string) => void;
  resizeSplit: (splitId: string, sizes: number[]) => void;
  focusLeaf: (leafId: string) => void;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | undefined>(undefined);

function createId(): string {
  return crypto.randomUUID();
}

/** `focusedLeafId` if it still exists in `root`, else the tree's first leaf. */
function fallbackFocus(root: PaneNode, focusedLeafId: string): string {
  if (findLeaf(root, focusedLeafId)) return focusedLeafId;
  return listLeaves(root)[0].id;
}

/** Shared by `openTab`'s `newSplit` option and the standalone `splitLeaf` action. */
function performSplit(
  root: PaneNode,
  leafId: string,
  direction: SplitDirection
): { root: PaneNode; newLeafId: string } {
  const newSplitId = createId();
  const newLeafId = createId();
  return { root: splitLeafInTree(root, leafId, newSplitId, newLeafId, direction), newLeafId };
}

export interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps): React.ReactElement {
  const [state, setState] = useLocalStorage<WorkspaceState>(STORAGE_KEY, DEFAULT_STATE);

  const openTab = React.useCallback<WorkspaceContextValue['openTab']>(
    (kind, params = {}, opts) => {
      setState((prev) => {
        let root = prev.root;
        let targetLeafId = prev.focusedLeafId;

        if (opts?.newSplit) {
          const split = performSplit(root, prev.focusedLeafId, opts.newSplit);
          root = split.root;
          targetLeafId = split.newLeafId;
        }

        const tab: TabState = { id: createId(), kind, params, source: opts?.source ?? 'launcher' };
        return { root: openTabInLeaf(root, targetLeafId, tab), focusedLeafId: targetLeafId };
      });
    },
    [setState]
  );

  const closeTab = React.useCallback<WorkspaceContextValue['closeTab']>(
    (leafId, tabId) => {
      setState((prev) => ({ ...prev, root: closeTabInTree(prev.root, leafId, tabId) }));
    },
    [setState]
  );

  const activateTab = React.useCallback<WorkspaceContextValue['activateTab']>(
    (leafId, tabId) => {
      setState((prev) => ({ ...prev, root: activateTabInTree(prev.root, leafId, tabId) }));
    },
    [setState]
  );

  const reorderTab = React.useCallback<WorkspaceContextValue['reorderTab']>(
    (leafId, tabId, toIndex) => {
      setState((prev) => ({ ...prev, root: reorderTabInTree(prev.root, leafId, tabId, toIndex) }));
    },
    [setState]
  );

  const splitLeaf = React.useCallback<WorkspaceContextValue['splitLeaf']>(
    (leafId, direction) => {
      setState((prev) => {
        const split = performSplit(prev.root, leafId, direction);
        return { root: split.root, focusedLeafId: split.newLeafId };
      });
    },
    [setState]
  );

  const closeLeaf = React.useCallback<WorkspaceContextValue['closeLeaf']>(
    (leafId) => {
      setState((prev) => {
        const root = closeLeafInTree(prev.root, leafId);
        return { root, focusedLeafId: fallbackFocus(root, prev.focusedLeafId) };
      });
    },
    [setState]
  );

  const resizeSplit = React.useCallback<WorkspaceContextValue['resizeSplit']>(
    (splitId, sizes) => {
      setState((prev) => ({ ...prev, root: resizeSplitInTree(prev.root, splitId, sizes) }));
    },
    [setState]
  );

  const focusLeaf = React.useCallback<WorkspaceContextValue['focusLeaf']>(
    (leafId) => {
      setState((prev) => (findLeaf(prev.root, leafId) ? { ...prev, focusedLeafId: leafId } : prev));
    },
    [setState]
  );

  const value = React.useMemo<WorkspaceContextValue>(
    () => ({
      root: state.root,
      focusedLeafId: state.focusedLeafId,
      openTab,
      closeTab,
      activateTab,
      reorderTab,
      splitLeaf,
      closeLeaf,
      resizeSplit,
      focusLeaf,
    }),
    [
      state,
      openTab,
      closeTab,
      activateTab,
      reorderTab,
      splitLeaf,
      closeLeaf,
      resizeSplit,
      focusLeaf,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = React.useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
