'use client';

/**
 * DataChangeProvider — the shell-wide "this changed, whoever is showing it
 * should catch up" channel.
 *
 * ## Why this is a second thing rather than a wider first thing
 *
 * `TabRefreshBoundary` (`tabs/tab-refresh-context.tsx`) already scopes a
 * refresh to one tab, which is exactly right for a control rendered inside
 * one. The writes this provider exists for are the ones that happen
 * *nowhere in particular*: Sparkey capturing a thought, an instruct turn
 * calling `resparkable_upsert_goal`, Activity accepting a suggestion. Those
 * panes sit beside the pane tree with no boundary above them, so the tab
 * seam's fallback (`router.refresh()`) re-renders the single route-backed
 * tab and leaves every launcher-opened tab as stale as it was.
 *
 * Widening the tab seam to "refresh everything" would have brought back the
 * exact problem it was built to fix: dragging a card in one pane reflowing
 * an unrelated pane two over. So this is narrow instead. A writer says what
 * it touched, `change-scope.ts` says which tabs care, and nothing else moves.
 *
 * ## Shape
 *
 * Two contexts over a plain `Record<key, counter>`, rather than an event
 * emitter with subscribers. Counters compose with the boundary's own local counter by
 * addition, which is what lets one `generation` number carry both an in-tab
 * refresh and a broadcast into `useTabFetch`'s effect deps, with no second
 * mechanism and no ordering between them. It also means a subscriber that
 * mounts after a change reads the already-bumped value rather than having
 * missed an event.
 *
 * Every boundary re-renders when any change lands, since they all read this
 * one context value. That costs nothing measurable: `TabContent` builds its
 * child element before handing it to the boundary, so the element identity
 * is unchanged and React bails out of the subtree unless the boundary's own
 * generation actually moved.
 *
 * ## Outside the shell
 *
 * `useNotifyDataChange()` returns a no-op when no provider is above it, the
 * same way `useResparkableRefresh()` degrades to `router.refresh()`. A form
 * on a plain page, or a component under test with no shell around it, keeps
 * working and simply broadcasts to nobody.
 */

import * as React from 'react';

import {
  keysForChange,
  type ResparkableChange,
} from '@/lib/framework/resparkable/ui/workspace/change-scope';

type Revisions = Readonly<Record<string, number>>;
type Notify = (changes: ResparkableChange | ResparkableChange[]) => void;

/**
 * Two contexts, not one object with both halves in it. They change on
 * completely different schedules: `notify` never changes for the life of the
 * provider, and `revisions` changes on every write in the app. Bundled
 * together, every *writer* — Sparkey with its whole transcript, Activity with
 * its whole list — would re-render each time any unrelated write landed,
 * purely because the object holding its unchanged callback was rebuilt. Split,
 * a writer subscribes to something that never changes and re-renders never.
 */
const RevisionsContext = React.createContext<Revisions | null>(null);
const NotifyContext = React.createContext<Notify | null>(null);

const NO_REVISIONS: Revisions = {};

/** Stable across renders, so it is safe in a dependency list. */
const NOOP_NOTIFY: Notify = () => {};

export interface DataChangeProviderProps {
  children: React.ReactNode;
}

export function DataChangeProvider({ children }: DataChangeProviderProps): React.ReactElement {
  const [revisions, setRevisions] = React.useState<Revisions>(NO_REVISIONS);

  const notify = React.useCallback<Notify>((changes) => {
    const list = Array.isArray(changes) ? changes : [changes];
    if (list.length === 0) return;
    setRevisions((prev) => {
      const next = { ...prev };
      for (const change of list) {
        for (const key of keysForChange(change)) next[key] = (next[key] ?? 0) + 1;
      }
      return next;
    });
  }, []);

  return (
    <NotifyContext.Provider value={notify}>
      <RevisionsContext.Provider value={revisions}>{children}</RevisionsContext.Provider>
    </NotifyContext.Provider>
  );
}

/**
 * What a write outside a tab calls once it lands. Naming the record's id when
 * it is known keeps a detail tab for some *other* record from refetching for
 * nothing; omitting it is honest and still reaches every detail tab of that
 * type. See `change-scope.ts` on the unknown-id key.
 */
export function useNotifyDataChange(): Notify {
  return React.useContext(NotifyContext) ?? NOOP_NOTIFY;
}

/**
 * The summed revision of `keys`, or `0` with no provider above.
 *
 * Only `TabRefreshBoundary` should read this. `keys` is read, not retained,
 * so a caller passing a freshly-built array each render costs nothing.
 */
export function useDataRevision(keys: readonly string[]): number {
  const revisions = React.useContext(RevisionsContext) ?? NO_REVISIONS;
  let total = 0;
  for (const key of keys) total += revisions[key] ?? 0;
  return total;
}
