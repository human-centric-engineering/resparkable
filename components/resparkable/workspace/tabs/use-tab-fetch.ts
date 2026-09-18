'use client';

/**
 * useTabFetch — the client-side counterpart to `readResparkable` (Phase 3).
 *
 * Every existing Resparkable page fetches server-side, once, and hands the
 * validated result to a View component as a prop. A launcher-opened
 * Workspace tab has no server render to do that fetch in — this hook is
 * what lets `workspace/tabs/*-tab.tsx` reproduce the same
 * fetch-then-validate contract from the client instead, so the View
 * components themselves stay completely unmodified.
 *
 * `endpoint: null` means "don't fetch yet" rather than "fetch nothing" —
 * both Graph (no focus selected) and Board (slug not yet resolved to an id)
 * need a state where a *later* render supplies the real endpoint once a
 * prior fetch answers what it should be, and this is what makes that a
 * plain prop change rather than a manual effect-cancellation dance at each
 * call site.
 */

import * as React from 'react';
import type { z } from 'zod';

import { useTabRefreshGeneration } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { APIClientError } from '@/lib/api/client';
import { resparkableApi } from '@/lib/framework/resparkable/api/client';

export type TabFetchState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; httpStatus: number | null }
  | { status: 'ready'; data: T };

const GENERIC_ERROR = 'Couldn’t reach the server.';
const SHAPE_ERROR = 'That response wasn’t what we expected.';

/**
 * Fetches `endpoint` (any query string already baked in, matching how every
 * server page builds its own `readResparkable` path) and validates the
 * response with `schema`. Re-fetches whenever `endpoint` changes, and
 * ignores a response that resolves after `endpoint` has already changed
 * again or the caller has unmounted.
 *
 * Also re-fetches when the enclosing tab is refreshed — a mutation anywhere
 * in this tab's content calling `useResparkableRefresh()` (see
 * `tab-refresh-context.tsx`). That is what gives a launcher-opened tab the
 * "I changed something, show me the new state" behavior `router.refresh()`
 * used to provide on a real page, scoped to this pane instead of the whole
 * route segment. Outside a tab the generation is a constant `0`, so this
 * hook behaves exactly as it did before.
 */
export function useTabFetch<T>(
  endpoint: string | null,
  schema: z.ZodType<T>,
  /**
   * An extra revision to refetch on, for a caller with no `TabRefreshBoundary`
   * above it. `Launcher` is the one that needs it: it renders in an *empty*
   * pane, so it is outside every boundary and its generation is a constant
   * `0` — its Inbox badge could never change while it was on screen, which is
   * precisely the situation it was brought back for. It passes
   * `useDataRevision(['thought'])`. Tabs leave this alone; their boundary
   * already folds the broadcast in.
   */
  revalidateOn = 0
): [TabFetchState<T>, () => void] {
  const [state, setState] = React.useState<TabFetchState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const generation = useTabRefreshGeneration() + revalidateOn;
  /** The endpoint the data currently in `state` came from. See the effect below. */
  const loadedFrom = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (endpoint === null) return;

    let cancelled = false;
    // Revalidate in place rather than resetting to `loading`.
    //
    // Every adapter early-returns a skeleton on `loading`, so resetting here
    // unmounts the tab's whole client subtree and remounts it on the next
    // render — and a refresh is now something another pane can trigger. A
    // Sparkey capture would throw away a Note tab's in-progress edit (its
    // `content` state, and with it the characters typed since the last
    // debounced save), an Inbox tab's open promote dialog, or a Today tab's
    // optimistic tick. `router.refresh()`, which this seam replaced, kept
    // client state across a refresh; losing it would be a regression rather
    // than the fix this was meant to be.
    //
    // A skeleton is still right when there is nothing to hold on to: the
    // first load, a switch to a different endpoint, or a retry after an
    // error, where continuing to show the error until the refetch lands
    // would make the retry button look dead.
    setState((prev) =>
      prev.status === 'ready' && loadedFrom.current === endpoint ? prev : { status: 'loading' }
    );

    resparkableApi
      .get<unknown>(endpoint)
      .then((raw) => {
        if (cancelled) return;
        const parsed = schema.safeParse(raw);
        if (parsed.success) loadedFrom.current = endpoint;
        setState(
          parsed.success
            ? { status: 'ready', data: parsed.data }
            : { status: 'error', message: SHAPE_ERROR, httpStatus: null }
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: error instanceof APIClientError ? error.message : GENERIC_ERROR,
          // Lets a caller distinguish "not found" from any other failure the
          // same way the server pages do with `readResparkable`'s `status`
          // field — checking the message string instead would be guessing.
          httpStatus: error instanceof APIClientError ? (error.status ?? null) : null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint, attempt, generation, schema]);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}
