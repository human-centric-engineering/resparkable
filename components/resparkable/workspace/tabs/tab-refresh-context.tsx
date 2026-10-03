'use client';

/**
 * The refresh seam — one hook that means "show me the current state of the
 * thing I just changed", and resolves to the right mechanism for wherever
 * the calling component happens to be rendered.
 *
 * ## The problem this replaces
 *
 * Nearly every mutating control in Resparkable (`ThoughtCard`'s triage
 * buttons, `TaskRow`'s pin/snooze, `BoardView`'s card drag, every
 * `CreateDialog` on close) used to finish with `router.refresh()`. That was
 * correct while each surface was its own page: refetch this route, re-render
 * this page. Since the three-pane shell landed, it is wrong in two directions
 * at once.
 *
 * **Too wide.** `router.refresh()` refetches the whole current route segment,
 * and *every* pane in the workspace sits under that one segment. Dragging a
 * card in a Board tab made an unrelated Projects tab two panes over refetch
 * and reflow.
 *
 * **Too narrow.** A launcher-opened tab has no route of its own — its data
 * came from `useTabFetch`, not from the server render of whatever URL the
 * address bar happens to hold. Refreshing that route re-renders a page this
 * pane isn't even showing, and the tab's own stale data stays exactly as
 * stale as it was. The mutation appeared to do nothing.
 *
 * ## How it resolves
 *
 * `TabRefreshBoundary` wraps each tab's content in `tab-content.tsx` and owns
 * a plain counter. `useResparkableRefresh()` returns that counter's bump when
 * a boundary is above it, and `router.refresh` when none is — so:
 *
 * - **Inside a launcher-opened tab**: refetches that one tab's own data,
 *   touching no other pane. `useTabFetch` re-runs because the generation is
 *   one of its effect deps, which is what makes this work with zero wiring
 *   per adapter — a new tab kind inherits it by using the hook at all.
 * - **Inside the route-backed tab**: there is no boundary, because that tab
 *   renders the real server page (`routeContent`), not `TabContent`. It gets
 *   `router.refresh()`, which is right: for that one tab the URL genuinely is
 *   its identity, and the SSR output is genuinely what needs re-rendering.
 * - **On a plain page** (`/resparkable/capture`, the admin surfaces, anything
 *   outside the shell): also `router.refresh()`, unchanged from before.
 *
 * The fallback is what makes this safe to adopt one component at a time: a
 * component that switches to the hook behaves identically to how it did
 * everywhere it already worked, and only changes behavior where it was
 * already broken.
 *
 * ## The half this alone cannot do
 *
 * "Refresh the tab I am in" is meaningless to a writer that is not in a tab.
 * Sparkey and Activity are panes beside the pane tree, so for them the hook
 * resolves to `router.refresh()`, which re-renders the one route-backed tab
 * and leaves every launcher-opened tab exactly as stale as before. Capturing
 * a thought in Sparkey did not put it in an open Inbox tab.
 *
 * `data-change-context.tsx` is the other half: a writer names *what it
 * touched*, `change-scope.ts` says which tab kinds care, and this boundary
 * adds the matching counters to its own. Both arrive at `useTabFetch` as one
 * `generation` number, so there is no second mechanism and no ordering
 * between them. `refresh()` takes an optional change for exactly this: a
 * caller that can say what it wrote reaches the other panes too, and a caller
 * that says nothing behaves precisely as it did before.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';

import {
  useDataRevision,
  useNotifyDataChange,
} from '@/components/resparkable/workspace/data-change-context';
import {
  keysForTab,
  type ResparkableChange,
} from '@/lib/framework/resparkable/ui/workspace/change-scope';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

interface TabRefreshValue {
  /** Bumped by `refresh()`; read by `useTabFetch` as an effect dependency. */
  generation: number;
  refresh: () => void;
}

const TabRefreshContext = React.createContext<TabRefreshValue | null>(null);

export interface TabRefreshBoundaryProps {
  /** The tab being wrapped. Read only to work out what changes it cares about. */
  tab: TabState;
  children: React.ReactNode;
}

/**
 * Scopes refreshes to one tab's content. Rendered once per tab by
 * `tab-content.tsx`, so two panes showing the same kind each get their own
 * counter and refresh independently.
 *
 * The generation is the sum of two independent counters: this boundary's own,
 * bumped by a control inside the tab, and the broadcast revision for the
 * change keys this tab subscribes to. Addition rather than a tuple because
 * `useTabFetch` only ever asks "is this a different number than last time",
 * and one number keeps its dependency list unchanged.
 */
export function TabRefreshBoundary({ tab, children }: TabRefreshBoundaryProps): React.ReactElement {
  const [local, setLocal] = React.useState(0);
  const broadcast = useDataRevision(keysForTab(tab.kind, tab.params));
  const refresh = React.useCallback(() => setLocal((n) => n + 1), []);
  const generation = local + broadcast;
  const value = React.useMemo<TabRefreshValue>(
    () => ({ generation, refresh }),
    [generation, refresh]
  );
  return <TabRefreshContext.Provider value={value}>{children}</TabRefreshContext.Provider>;
}

/**
 * What a mutating control calls once its write lands. The replacement for a
 * bare `router.refresh()` anywhere under `components/resparkable/`.
 *
 * Pass `change` when the caller knows what it wrote: the refresh then also
 * reaches tabs in *other* panes showing the same thing, which is the only way
 * a write originating outside the pane tree can reach any tab at all. Omit it
 * and the behavior is unchanged from before the broadcast existed.
 *
 * Returns a stable callback, so it is safe in a `useCallback`/`useEffect`
 * dependency list.
 */
export function useResparkableRefresh(): (
  change?: ResparkableChange | ResparkableChange[]
) => void {
  const context = React.useContext(TabRefreshContext);
  const router = useRouter();
  const notify = useNotifyDataChange();
  const contextRefresh = context?.refresh;

  return React.useCallback(
    (change) => {
      if (change) notify(change);
      if (contextRefresh) {
        contextRefresh();
        return;
      }
      router.refresh();
    },
    [contextRefresh, notify, router]
  );
}

/**
 * The enclosing tab's refresh counter, or `0` outside any tab.
 *
 * Only `useTabFetch` should read this. It exists so a refresh re-runs every
 * fetch the tab made — not just the one a given control happens to know
 * about — which is the same "the whole surface is now stale" semantics
 * `router.refresh()` had, scoped down to one pane.
 */
export function useTabRefreshGeneration(): number {
  return React.useContext(TabRefreshContext)?.generation ?? 0;
}
