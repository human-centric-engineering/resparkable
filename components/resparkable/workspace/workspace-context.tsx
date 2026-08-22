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
  detachTab as detachTabInTree,
  findLeaf,
  listLeaves,
  openTabInLeaf,
  reorderTab as reorderTabInTree,
  resizeSplit as resizeSplitInTree,
  setRouteTab as setRouteTabInTree,
  setTabParams as setTabParamsInTree,
  setTabTitle as setTabTitleInTree,
  showLauncher as showLauncherInTree,
  splitLeaf as splitLeafInTree,
  type PaneNode,
  type SplitDirection,
} from '@/lib/framework/resparkable/ui/workspace/split-tree';
import {
  addFloatingPanel,
  bringFloatingPanelToFront,
  moveFloatingPanel as moveFloatingPanelInList,
  nextZIndex,
  removeFloatingPanel,
  resizeFloatingPanel as resizeFloatingPanelInList,
  updateFloatingPanelTab,
  type FloatingPanel,
} from '@/lib/framework/resparkable/ui/workspace/floating-panels';
import type {
  TabKind,
  TabParams,
  TabSource,
  TabState,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

// v2: added `floatingPanels` — a v1 blob has no such field, and this hook's
// bare `JSON.parse` performs no schema merge, so a bumped key is what avoids
// scattering `?? []` defensive reads through every action below. Existing
// users' saved pane layout resets once on first load after this ships.
const STORAGE_KEY = 'resparkable.workspace.v2';

/** The one leaf that exists before anything is ever opened. Never removed — see `closeLeaf`'s guarantee. */
const ROOT_LEAF_ID = 'root';

export interface WorkspaceState {
  root: PaneNode;
  focusedLeafId: string;
  /** Tabs dragged out of the pane tree into their own floating windows. */
  floatingPanels: FloatingPanel[];
}

const DEFAULT_STATE: WorkspaceState = {
  root: createLeaf(ROOT_LEAF_ID),
  focusedLeafId: ROOT_LEAF_ID,
  floatingPanels: [],
};

/** A freshly detached panel's starting size, when the drag didn't imply one of its own. */
const DEFAULT_FLOATING_WIDTH = 360;
const DEFAULT_FLOATING_HEIGHT = 280;

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
  /** The "+" affordance — shows the launcher in `leafId` without closing its tabs. */
  showLauncher: (leafId: string) => void;
  /**
   * `route-tab-bridge.tsx`'s (Phase 8) only write — syncs the tree's one
   * `source: 'route'` tab to whatever route just matched, replacing it in
   * place rather than opening a second one. See `setRouteTab` in
   * `split-tree.ts` for the invariant this maintains.
   */
  syncRouteTab: (kind: TabKind, params?: TabParams) => void;

  /**
   * Merges `patch` into one tab's own params — how a launcher-opened tab
   * changes its filter (Plan's day, Projects' status, Search's include-archived)
   * **without touching the browser URL**.
   *
   * That distinction is the whole point. Before this existed, those filters
   * lived in `useSearchParams()`, which every pane reads: changing the day in
   * one Plan tab moved every other Plan tab with it, and moved the address bar
   * besides. The tree's one `source: 'route'` tab is the deliberate exception
   * and still tracks the URL — its params are written by `syncRouteTab`, and
   * the real page it renders still navigates when its own controls change,
   * because for that one tab the URL *is* its identity.
   *
   * Keyed on the tab id alone, so a floating detached tab is reachable too.
   */
  setTabParams: (tabId: string, patch: Partial<TabParams>) => void;
  /** Names a tab from its own loaded content — see `TabState.title`. */
  setTabTitle: (tabId: string, title: string) => void;

  /** Tabs dragged out of the pane tree into their own floating windows. */
  floatingPanels: FloatingPanel[];
  /**
   * Pulls `tabId` out of leaf `leafId` into a new floating panel at
   * `position` — a no-op if the tab is the tree's `source: 'route'` tab (see
   * `detachTab` in `split-tree.ts`) or already gone.
   */
  detachTab: (leafId: string, tabId: string, position: { x: number; y: number }) => void;
  /** Docks a floating panel's tab into `targetLeafId`, appended and activated, and removes the panel. */
  dockPanel: (panelId: string, targetLeafId: string) => void;
  moveFloatingPanel: (panelId: string, x: number, y: number) => void;
  resizeFloatingPanel: (panelId: string, width: number, height: number) => void;
  /** Discards a floating panel's tab — no auto-redock. A `FloatingTabWindow`'s own redock button handles that. */
  closeFloatingPanel: (panelId: string) => void;
  /** Brings a floating panel to the front of the paint order. */
  focusFloatingPanel: (panelId: string) => void;
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
        return {
          ...prev,
          root: openTabInLeaf(root, targetLeafId, tab),
          focusedLeafId: targetLeafId,
        };
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
        return { ...prev, root: split.root, focusedLeafId: split.newLeafId };
      });
    },
    [setState]
  );

  const closeLeaf = React.useCallback<WorkspaceContextValue['closeLeaf']>(
    (leafId) => {
      setState((prev) => {
        const root = closeLeafInTree(prev.root, leafId);
        return { ...prev, root, focusedLeafId: fallbackFocus(root, prev.focusedLeafId) };
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

  const showLauncher = React.useCallback<WorkspaceContextValue['showLauncher']>(
    (leafId) => {
      setState((prev) => ({ ...prev, root: showLauncherInTree(prev.root, leafId) }));
    },
    [setState]
  );

  const syncRouteTab = React.useCallback<WorkspaceContextValue['syncRouteTab']>(
    (kind, params = {}) => {
      setState((prev) => {
        const tab: TabState = { id: createId(), kind, params, source: 'route' };
        const { root, leafId } = setRouteTabInTree(prev.root, tab, prev.focusedLeafId);
        return { ...prev, root, focusedLeafId: leafId };
      });
    },
    [setState]
  );

  // Both of these write to the tree *and* the floating-panel list, because a
  // tab id resolves to exactly one of the two and the caller doesn't know
  // which. Each helper returns its input unchanged when nothing matched, so
  // the miss costs one identity comparison rather than a wasted re-render.
  const setTabParams = React.useCallback<WorkspaceContextValue['setTabParams']>(
    (tabId, patch) => {
      setState((prev) => {
        const root = setTabParamsInTree(prev.root, tabId, patch);
        const floatingPanels = updateFloatingPanelTab(prev.floatingPanels, tabId, (tab) => ({
          ...tab,
          params: { ...tab.params, ...patch },
        }));
        if (root === prev.root && floatingPanels === prev.floatingPanels) return prev;
        return { ...prev, root, floatingPanels };
      });
    },
    [setState]
  );

  const setTabTitle = React.useCallback<WorkspaceContextValue['setTabTitle']>(
    (tabId, title) => {
      setState((prev) => {
        const root = setTabTitleInTree(prev.root, tabId, title);
        const floatingPanels = updateFloatingPanelTab(prev.floatingPanels, tabId, (tab) =>
          tab.title === title ? tab : { ...tab, title }
        );
        if (root === prev.root && floatingPanels === prev.floatingPanels) return prev;
        return { ...prev, root, floatingPanels };
      });
    },
    [setState]
  );

  const detachTab = React.useCallback<WorkspaceContextValue['detachTab']>(
    (leafId, tabId, position) => {
      setState((prev) => {
        const { root, tab } = detachTabInTree(prev.root, leafId, tabId);
        if (!tab) return prev;
        const panel: FloatingPanel = {
          id: createId(),
          tab,
          originLeafId: leafId,
          x: position.x,
          y: position.y,
          width: DEFAULT_FLOATING_WIDTH,
          height: DEFAULT_FLOATING_HEIGHT,
          z: nextZIndex(prev.floatingPanels),
        };
        return { ...prev, root, floatingPanels: addFloatingPanel(prev.floatingPanels, panel) };
      });
    },
    [setState]
  );

  const dockPanel = React.useCallback<WorkspaceContextValue['dockPanel']>(
    (panelId, targetLeafId) => {
      setState((prev) => {
        const panel = prev.floatingPanels.find((candidate) => candidate.id === panelId);
        if (!panel) return prev;
        return {
          ...prev,
          root: openTabInLeaf(prev.root, targetLeafId, panel.tab),
          focusedLeafId: targetLeafId,
          floatingPanels: removeFloatingPanel(prev.floatingPanels, panelId),
        };
      });
    },
    [setState]
  );

  const moveFloatingPanel = React.useCallback<WorkspaceContextValue['moveFloatingPanel']>(
    (panelId, x, y) => {
      setState((prev) => ({
        ...prev,
        floatingPanels: moveFloatingPanelInList(prev.floatingPanels, panelId, x, y),
      }));
    },
    [setState]
  );

  const resizeFloatingPanel = React.useCallback<WorkspaceContextValue['resizeFloatingPanel']>(
    (panelId, width, height) => {
      setState((prev) => ({
        ...prev,
        floatingPanels: resizeFloatingPanelInList(prev.floatingPanels, panelId, width, height),
      }));
    },
    [setState]
  );

  const closeFloatingPanel = React.useCallback<WorkspaceContextValue['closeFloatingPanel']>(
    (panelId) => {
      setState((prev) => ({
        ...prev,
        floatingPanels: removeFloatingPanel(prev.floatingPanels, panelId),
      }));
    },
    [setState]
  );

  const focusFloatingPanel = React.useCallback<WorkspaceContextValue['focusFloatingPanel']>(
    (panelId) => {
      setState((prev) => ({
        ...prev,
        floatingPanels: bringFloatingPanelToFront(prev.floatingPanels, panelId),
      }));
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
      showLauncher,
      syncRouteTab,
      setTabParams,
      setTabTitle,
      floatingPanels: state.floatingPanels,
      detachTab,
      dockPanel,
      moveFloatingPanel,
      resizeFloatingPanel,
      closeFloatingPanel,
      focusFloatingPanel,
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
      showLauncher,
      syncRouteTab,
      setTabParams,
      setTabTitle,
      detachTab,
      dockPanel,
      moveFloatingPanel,
      resizeFloatingPanel,
      closeFloatingPanel,
      focusFloatingPanel,
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

/**
 * The workspace if there is one, `null` if not, without throwing.
 *
 * For the components that are shared between the shell and a plain page and
 * have a real answer either way. `WorkspaceLink` is the reason it exists: the
 * same `<EntityChip>` renders inside a tab, where a click should open a tab,
 * and on `/resparkable/capture`, where a click is ordinary navigation. Every
 * other caller wants {@link useWorkspace}'s throw, which catches a pane
 * component rendered somewhere it cannot work.
 */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return React.useContext(WorkspaceContext) ?? null;
}
