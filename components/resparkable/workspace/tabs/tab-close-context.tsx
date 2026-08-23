'use client';

/**
 * TabCloseProvider — "close the tab I am in", for content that cannot know
 * which tab that is.
 *
 * ## Why this is a closure and not an id
 *
 * Every other tab-scoped action in the workspace keys on the tab id alone
 * (`setTabTitle`, `setTabParams`), deliberately, so an adapter never has to be
 * told which pane is rendering it or whether it is floating in a window
 * instead — see `tab-content.tsx`'s own header. `closeTab` is the first action
 * that breaks that premise: it is `closeTab(leafId, tabId)`, and `leafId` stops
 * at `WorkspacePane`.
 *
 * Threading a `leafId` down would not have worked anyway, because "close me"
 * resolves to two different actions in two different id spaces:
 *
 * | Where the tab is | How it closes |
 * | ---------------- | ------------- |
 * | docked in a pane | `closeTab(leaf.id, tab.id)` |
 * | detached into a floating window | `closeFloatingPanel(panel.id)` |
 *
 * A floating tab has no live `leafId` at all — `FloatingPanel.originLeafId` is
 * the redock button's fallback target and is stale by design, so
 * `closeTab(originLeafId, …)` would silently no-op. So what goes down is the
 * already-resolved callback, built by whoever knows which of the two applies.
 *
 * ## Its own context, not `workspace-context.tsx` and not the refresh boundary
 *
 * Not exported from `workspace-context.tsx`, because seven adapter test files
 * `vi.mock` that module with a factory returning only `useWorkspace`; a new
 * export there resolves to `undefined` in all of them at once.
 *
 * Not folded into `TabRefreshBoundary`'s value either, though that component
 * already holds the whole `TabState` at the right node. Its value carries a
 * `generation` that changes on every refresh, so a consumer of "how do I
 * close?" would re-render on every refetch of data it does not read.
 *
 * ## The route-backed tab has no provider, on purpose
 *
 * `WorkspacePane` wraps only the `TabContent` branch. The route-backed tab
 * renders the real server page, and for that one tab the browser URL *is* its
 * identity — so navigating away changes that tab and nothing else, which is
 * what its callers want and what `useOptionalTabClose()` returning `null`
 * lets them fall through to.
 */

import * as React from 'react';

const TabCloseContext = React.createContext<(() => void) | null>(null);

export interface TabCloseProviderProps {
  /** Already resolved to the right action for where this tab lives. */
  close: () => void;
  children: React.ReactNode;
}

export function TabCloseProvider({ close, children }: TabCloseProviderProps): React.ReactElement {
  return <TabCloseContext.Provider value={close}>{children}</TabCloseContext.Provider>;
}

/**
 * How to close the enclosing tab, or `null` where there is nothing to close —
 * a plain page under `app/`, or the route-backed tab.
 *
 * Optional by design, like `useOptionalWorkspace()`: the components that call
 * this are shared between the workspace and a real page, and neither may throw
 * in the other's context.
 */
export function useOptionalTabClose(): (() => void) | null {
  return React.useContext(TabCloseContext);
}
