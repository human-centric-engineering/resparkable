// @vitest-environment happy-dom

/**
 * Unit Tests: RouteTabMarker / useIsRouteTab.
 *
 * `ArchiveControls` moves the browser URL after a delete only from inside the
 * route-backed tab, so the marker has to answer `true` there and `false`
 * everywhere else, including anything nested below an unmarked tree.
 *
 * @see components/resparkable/workspace/tabs/route-tab-context.tsx
 */

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as React from 'react';

import {
  RouteTabMarker,
  useIsRouteTab,
} from '@/components/resparkable/workspace/tabs/route-tab-context';

describe('useIsRouteTab', () => {
  it('is false with no marker above it', () => {
    const { result } = renderHook(() => useIsRouteTab());
    expect(result.current).toBe(false);
  });

  it('is true inside RouteTabMarker', () => {
    const { result } = renderHook(() => useIsRouteTab(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <RouteTabMarker>{children}</RouteTabMarker>
      ),
    });
    expect(result.current).toBe(true);
  });

  it('reaches a consumer nested well below the marker', () => {
    const { result } = renderHook(() => useIsRouteTab(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <RouteTabMarker>
          <div>
            <section>{children}</section>
          </div>
        </RouteTabMarker>
      ),
    });
    expect(result.current).toBe(true);
  });
});
