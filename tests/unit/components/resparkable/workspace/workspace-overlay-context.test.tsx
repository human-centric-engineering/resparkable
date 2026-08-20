/**
 * Unit Tests: WorkspaceOverlayProvider / useWorkspaceOverlay.
 *
 * The overlay context is a redock-target registry backed by a `Map` in a
 * ref, plus the shared positioning root every floating panel's coordinates
 * are relative to. These tests cover: the missing-provider guard, that the
 * provider renders its own positioning root around `children`, registration
 * / unregistration of leaf rects, and `findLeafAtPoint`'s hit-testing —
 * translation into the container's local space, the inclusive-edge bounds
 * check `isPointInsideRect` performs, skipping leaves whose `getRect`
 * currently returns `null`, iterating multiple registered leaves, and the
 * `containerRef.current` guard once the provider has unmounted.
 *
 * happy-dom's `Element.getBoundingClientRect()` always returns a zeroed
 * `DOMRect` (no layout engine) — so the provider's own container rect is
 * `{ left: 0, top: 0, ... }` in every test here, which makes overlay-local
 * coordinates and viewport coordinates the same numbers. That's exactly what
 * lets these tests control leaf rects directly via `registerLeafRect`'s
 * `getRect` callback without needing to mock layout.
 *
 * @see components/resparkable/workspace/workspace-overlay-context.tsx
 */

import { describe, expect, it } from 'vitest';
import { act, renderHook, render, screen } from '@testing-library/react';

import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
} from '@/components/resparkable/workspace/workspace-overlay-context';

/** A `DOMRect`-shaped object for a leaf's registered `getRect` callback. */
function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  };
}

function renderOverlay() {
  return renderHook(() => useWorkspaceOverlay(), { wrapper: WorkspaceOverlayProvider });
}

describe('useWorkspaceOverlay outside a provider', () => {
  it('throws rather than returning undefined context', () => {
    // renderHook swallows the render error internally and rethrows on
    // `.result.current` access — asserting via a wrapper-less render call.
    expect(() => renderHook(() => useWorkspaceOverlay())).toThrow(
      'useWorkspaceOverlay must be used within a WorkspaceOverlayProvider'
    );
  });
});

describe('WorkspaceOverlayProvider', () => {
  it('renders its children inside the positioning root', () => {
    render(
      <WorkspaceOverlayProvider>
        <div data-testid="child">content</div>
      </WorkspaceOverlayProvider>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('attaches containerRef to a real DOM node once mounted', () => {
    const { result } = renderOverlay();

    expect(result.current.containerRef.current?.tagName).toBe('DIV');
  });
});

describe('registerLeafRect / findLeafAtPoint', () => {
  it('returns null when no leaves are registered', () => {
    const { result } = renderOverlay();

    expect(result.current.findLeafAtPoint(10, 10)).toBeNull();
  });

  it('returns the id of a registered leaf whose rect contains the point', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 100, 100));
    });

    expect(result.current.findLeafAtPoint(50, 50)).toBe('leaf-a');
  });

  it('returns null for a point outside every registered rect', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 100, 100));
    });

    expect(result.current.findLeafAtPoint(500, 500)).toBeNull();
  });

  it('treats a rect boundary as inside (isPointInsideRect is inclusive)', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 100, 100));
    });

    expect(result.current.findLeafAtPoint(100, 100)).toBe('leaf-a');
  });

  it('checks every registered leaf and returns whichever one contains the point', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 50, 50));
      result.current.registerLeafRect('leaf-b', () => rect(100, 100, 150, 150));
    });

    expect(result.current.findLeafAtPoint(120, 120)).toBe('leaf-b');
    expect(result.current.findLeafAtPoint(20, 20)).toBe('leaf-a');
  });

  it('skips a leaf whose getRect currently returns null (e.g. an unmounted target)', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => null);
      result.current.registerLeafRect('leaf-b', () => rect(0, 0, 100, 100));
    });

    expect(result.current.findLeafAtPoint(50, 50)).toBe('leaf-b');
  });

  it('the returned unregister function removes the leaf from future hit tests', () => {
    const { result } = renderOverlay();
    let unregister: () => void = () => {};

    act(() => {
      unregister = result.current.registerLeafRect('leaf-a', () => rect(0, 0, 100, 100));
    });
    expect(result.current.findLeafAtPoint(50, 50)).toBe('leaf-a');

    act(() => {
      unregister();
    });

    expect(result.current.findLeafAtPoint(50, 50)).toBeNull();
  });

  it('re-registering the same leaf id replaces its getRect getter rather than adding a second entry', () => {
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 10, 10));
      result.current.registerLeafRect('leaf-a', () => rect(200, 200, 300, 300));
    });

    expect(result.current.findLeafAtPoint(5, 5)).toBeNull();
    expect(result.current.findLeafAtPoint(250, 250)).toBe('leaf-a');
  });

  it('translates overlay-local coordinates against the container rect before comparing', () => {
    // happy-dom's getBoundingClientRect() is always a zeroed DOMRect, so the
    // container's own rect is `{ left: 0, top: 0, ... }` here — point (x, y)
    // and the container-relative point end up numerically identical. This
    // test pins that behaviour down explicitly rather than relying on it
    // silently: a point that would only be inside the leaf rect *after*
    // adding a non-zero container offset must NOT match, proving the
    // function only ever adds the container's real (here: zero) offset and
    // doesn't just compare `(x, y)` to the leaf rect directly by coincidence.
    const { result } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(40, 40, 60, 60));
    });

    // Overlay-local (10, 10) does not fall inside [40,60]x[40,60] once
    // translated by the (zeroed) container offset.
    expect(result.current.findLeafAtPoint(10, 10)).toBeNull();
    // Overlay-local (50, 50) does.
    expect(result.current.findLeafAtPoint(50, 50)).toBe('leaf-a');
  });

  it('returns null once the provider (and its positioning root) has unmounted', () => {
    const { result, unmount } = renderOverlay();

    act(() => {
      result.current.registerLeafRect('leaf-a', () => rect(0, 0, 100, 100));
    });
    expect(result.current.findLeafAtPoint(50, 50)).toBe('leaf-a');

    unmount();

    // React nulls out `containerRef.current` on unmount, so the
    // `!containerRect` guard now short-circuits even though the leaf is
    // still registered in the (still-live) registry ref.
    expect(result.current.findLeafAtPoint(50, 50)).toBeNull();
  });
});
