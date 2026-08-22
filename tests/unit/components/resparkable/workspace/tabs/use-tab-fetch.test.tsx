/**
 * Unit Tests: useTabFetch.
 *
 * Every one of Phase 3's 19 adapters is built on this hook, so its
 * contract is worth pinning down directly rather than only through
 * whichever adapter happens to exercise a given branch: the loading →
 * ready/error transition, `endpoint: null` skipping the fetch entirely
 * (Graph's "nothing selected" and Board's "waiting on the slug lookup"
 * both depend on this), `retry()` re-firing the same endpoint, and
 * `httpStatus` surfacing a real HTTP status rather than a guess from the
 * error message (the thing `ProjectTab`/`EntityTab`/`BoardTab` check to
 * tell "not found" apart from "the server is unwell"), and re-firing when
 * the enclosing tab is refreshed — the mechanism that makes a mutation
 * anywhere inside a launcher-opened tab show its new state without any
 * per-adapter wiring.
 *
 * @see components/resparkable/workspace/tabs/use-tab-fetch.ts
 */

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { z } from 'zod';

import {
  TabRefreshBoundary,
  useResparkableRefresh,
} from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { apiClient, APIClientError } from '@/lib/api/client';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

const schema = z.object({ title: z.string() });

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('useTabFetch', () => {
  it('starts loading, then becomes ready with the parsed data', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ title: 'hello' });

    const { result } = renderHook(() => useTabFetch('/x', schema));
    expect(result.current[0]).toEqual({ status: 'loading' });

    await waitFor(() => expect(result.current[0].status).toBe('ready'));
    expect(result.current[0]).toEqual({ status: 'ready', data: { title: 'hello' } });
  });

  it('never fetches when endpoint is null', async () => {
    const { result } = renderHook(() => useTabFetch(null, schema));

    // Give any accidental effect a tick to fire before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(result.current[0]).toEqual({ status: 'loading' });
  });

  it('surfaces the API error message and its real HTTP status', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Not found.', 'NOT_FOUND', 404));

    const { result } = renderHook(() => useTabFetch('/x', schema));
    await waitFor(() => expect(result.current[0].status).toBe('error'));

    expect(result.current[0]).toEqual({
      status: 'error',
      message: 'Not found.',
      httpStatus: 404,
    });
  });

  it('falls back to a generic message and a null httpStatus for a non-API error', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new TypeError('network down'));

    const { result } = renderHook(() => useTabFetch('/x', schema));
    await waitFor(() => expect(result.current[0].status).toBe('error'));

    expect(result.current[0]).toEqual({
      status: 'error',
      message: 'Couldn’t reach the server.',
      httpStatus: null,
    });
  });

  it('reports a shape mismatch as an error rather than throwing', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ nope: true });

    const { result } = renderHook(() => useTabFetch('/x', schema));
    await waitFor(() => expect(result.current[0].status).toBe('error'));

    expect(result.current[0]).toEqual({
      status: 'error',
      message: 'That response wasn’t what we expected.',
      httpStatus: null,
    });
  });

  it('re-fetches the same endpoint when retry() is called', async () => {
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(new APIClientError('First try failed.', 'ERR', 500))
      .mockResolvedValueOnce({ title: 'second try' });

    const { result } = renderHook(() => useTabFetch('/x', schema));
    await waitFor(() => expect(result.current[0].status).toBe('error'));

    result.current[1](); // retry()
    await waitFor(() => expect(result.current[0].status).toBe('ready'));

    expect(result.current[0]).toEqual({ status: 'ready', data: { title: 'second try' } });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when endpoint changes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ title: 'a' });

    const { result, rerender } = renderHook(({ endpoint }) => useTabFetch(endpoint, schema), {
      initialProps: { endpoint: '/a' },
    });
    await waitFor(() => expect(result.current[0].status).toBe('ready'));

    vi.mocked(apiClient.get).mockResolvedValue({ title: 'b' });
    rerender({ endpoint: '/b' });

    await waitFor(() =>
      expect(result.current[0]).toEqual({ status: 'ready', data: { title: 'b' } })
    );
    expect(apiClient.get).toHaveBeenCalledWith('/a');
    expect(apiClient.get).toHaveBeenCalledWith('/b');
  });
});

describe('useTabFetch — refreshing the enclosing tab', () => {
  // Any kind will do: these cases exercise the boundary's own counter, not
  // which broadcast keys the tab happens to subscribe to (that is
  // `change-scope.test.ts`'s job).
  const TAB: TabState = { id: 'tab-1', kind: 'inbox', params: {}, source: 'launcher' };

  function wrapper({ children }: { children: React.ReactNode }) {
    return <TabRefreshBoundary tab={TAB}>{children}</TabRefreshBoundary>;
  }

  it('re-fires the same endpoint when the tab is refreshed', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ title: 'first' });

    const { result } = renderHook(
      () => {
        const fetched = useTabFetch('/x', schema);
        return { fetched, refresh: useResparkableRefresh() };
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.fetched[0].status).toBe('ready'));
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.get).mockResolvedValue({ title: 'second' });
    act(() => result.current.refresh());

    await waitFor(() =>
      expect(result.current.fetched[0]).toEqual({ status: 'ready', data: { title: 'second' } })
    );
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get).toHaveBeenLastCalledWith('/x');
  });

  it('re-fires every fetch in the tab, not only the one the control knew about', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ title: 'x' });

    const { result } = renderHook(
      () => {
        useTabFetch('/a', schema);
        useTabFetch('/b', schema);
        return useResparkableRefresh();
      },
      { wrapper }
    );

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    act(() => result.current());

    // Four, not three: this is the "the whole surface is now stale" semantics
    // `router.refresh()` had, scoped down to one pane.
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(4));
  });

  it('still skips a null endpoint on refresh rather than fetching "null"', async () => {
    const { result } = renderHook(
      () => {
        useTabFetch(null, schema);
        return useResparkableRefresh();
      },
      { wrapper }
    );

    act(() => result.current());

    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
