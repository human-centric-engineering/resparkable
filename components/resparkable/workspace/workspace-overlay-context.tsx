'use client';

/**
 * WorkspaceOverlayContext — the redock target registry floating tab windows
 * hit-test against, and the shared positioning root both they and
 * `TabStrip`'s drag-out guard convert viewport coordinates against.
 *
 * A `Map` of DOM-rect getters with no reactive state of its own — kept
 * separate from `WorkspaceContextValue` deliberately: that context is
 * `useState`-backed and `useMemo`'d on every workspace mutation, so folding a
 * registration `Map` in there would cause needless re-renders on every pane
 * mount/unmount as `WorkspacePane` instances come and go across the tree.
 *
 * `WorkspacePane` (`workspace-pane-tree.tsx`) registers its own root
 * `<div>`'s rect once per leaf — covering whichever of its two states (tab
 * strip + content, or the `Launcher`) it currently shows, so redocking onto
 * an empty pane works the same way redocking onto a pane with open tabs
 * does, with no separate registration path to collide with it.
 *
 * The provider renders its own `relative` wrapping `<div>` around `children`
 * — the positioning root every floating panel's `left`/`top` and every drag
 * handler's coordinate math is relative to — rather than asking
 * `WorkspaceShell` to wire up a matching `relative` container by convention.
 * It mounts around *both* the desktop and mobile branches in
 * `WorkspaceShell` (not only the desktop one): `WorkspacePane` calls
 * `useWorkspaceOverlay()` unconditionally, and `MobilePaneSwitcher` renders
 * the same pane tree `RouteTabBridge` does on desktop — omitting the
 * provider there would crash the mobile layout, even though
 * `FloatingPanelsLayer` itself only ever mounts on desktop.
 */

import * as React from 'react';

import { isPointInsideRect } from '@/lib/framework/resparkable/ui/workspace/split-tree';

export interface WorkspaceOverlayContextValue {
  /** The overlay's own positioning root — what floating-panel/drag coordinates are relative to. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Registers `leafId`'s live bounding rect. Returns an unregister function. */
  registerLeafRect: (leafId: string, getRect: () => DOMRect | null) => () => void;
  /** The leaf whose registered rect contains `(x, y)` (overlay-local coordinates), or `null`. */
  findLeafAtPoint: (x: number, y: number) => string | null;
}

const WorkspaceOverlayContext = React.createContext<WorkspaceOverlayContextValue | undefined>(
  undefined
);

export interface WorkspaceOverlayProviderProps {
  children: React.ReactNode;
}

export function WorkspaceOverlayProvider({
  children,
}: WorkspaceOverlayProviderProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // A ref, not state: registration churns on every pane mount/unmount, and
  // none of that should itself trigger a render — only the drag handlers
  // that read it (via `findLeafAtPoint`) care about its current contents,
  // and those always run well after the relevant panes have (un)mounted.
  const registryRef = React.useRef<Map<string, () => DOMRect | null>>(new Map());

  const registerLeafRect = React.useCallback<WorkspaceOverlayContextValue['registerLeafRect']>(
    (leafId, getRect) => {
      registryRef.current.set(leafId, getRect);
      return () => {
        registryRef.current.delete(leafId);
      };
    },
    []
  );

  const findLeafAtPoint = React.useCallback<WorkspaceOverlayContextValue['findLeafAtPoint']>(
    (x, y) => {
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return null;
      // `x`/`y` arrive in the overlay's own local space; rects come back from
      // `getBoundingClientRect()` in viewport space — translate before comparing.
      const point = { x: containerRect.left + x, y: containerRect.top + y };
      for (const [leafId, getRect] of registryRef.current) {
        const rect = getRect();
        if (rect && isPointInsideRect(point, rect)) return leafId;
      }
      return null;
    },
    []
  );

  const value = React.useMemo<WorkspaceOverlayContextValue>(
    () => ({ containerRef, registerLeafRect, findLeafAtPoint }),
    [registerLeafRect, findLeafAtPoint]
  );

  return (
    <WorkspaceOverlayContext.Provider value={value}>
      <div ref={containerRef} className="relative h-full">
        {children}
      </div>
    </WorkspaceOverlayContext.Provider>
  );
}

export function useWorkspaceOverlay(): WorkspaceOverlayContextValue {
  const context = React.useContext(WorkspaceOverlayContext);
  if (context === undefined) {
    throw new Error('useWorkspaceOverlay must be used within a WorkspaceOverlayProvider');
  }
  return context;
}
