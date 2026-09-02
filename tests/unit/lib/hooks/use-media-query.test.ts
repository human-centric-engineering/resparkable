// @vitest-environment happy-dom

/**
 * Unit Tests: useMediaQuery.
 *
 * `window.matchMedia` isn't implemented by jsdom, so every test supplies
 * its own minimal `MediaQueryList` stub. The two things worth pinning
 * down: the hook starts `false` (matching SSR, before any effect can read
 * the real value) and updates when the media query list reports a change.
 *
 * @see lib/hooks/use-media-query.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useMediaQuery } from '@/lib/hooks/use-media-query';

function stubMatchMedia(initialMatches: boolean) {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => {
      changeHandler = handler;
    }),
    removeEventListener: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    fireChange: (matches: boolean) => {
      mql.matches = matches;
      changeHandler?.({ matches } as MediaQueryListEvent);
    },
    mql,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('resolves to the media query’s real value after mount', async () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('resolves to false when the query does not match', async () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    await waitFor(() => expect(result.current).toBe(false));
  });

  it('updates when the media query list reports a change', async () => {
    const { fireChange } = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    await waitFor(() => expect(result.current).toBe(false));
    fireChange(true);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('removes its listener on unmount', () => {
    const { mql } = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
