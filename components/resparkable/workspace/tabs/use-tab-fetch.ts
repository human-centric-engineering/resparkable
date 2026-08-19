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

import { apiClient, APIClientError } from '@/lib/api/client';

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
 */
export function useTabFetch<T>(
  endpoint: string | null,
  schema: z.ZodType<T>
): [TabFetchState<T>, () => void] {
  const [state, setState] = React.useState<TabFetchState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (endpoint === null) return;

    let cancelled = false;
    setState({ status: 'loading' });

    apiClient
      .get<unknown>(endpoint)
      .then((raw) => {
        if (cancelled) return;
        const parsed = schema.safeParse(raw);
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
  }, [endpoint, attempt, schema]);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}
