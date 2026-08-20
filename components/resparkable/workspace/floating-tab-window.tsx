'use client';

/**
 * FloatingTabWindow — one tab that's been dragged out of its pane, rendered
 * as a free-floating, resizable window above the whole shell.
 *
 * Dragging (the title bar) and resizing (the corner handle) are both
 * hand-rolled pointer-event dragging rather than a library — there is no
 * floating-window primitive already in this codebase (`react-resizable-panels`
 * only lays out panels docked within one `PanelGroup`) and this is a small
 * enough job not to justify a new dependency for it.
 *
 * Both handlers keep their state updates on React's own synthetic
 * `onPointerMove`/`onPointerUp` props rather than `window.addEventListener` —
 * that keeps `moveFloatingPanel`/`dockPanel` inside React's normal batching,
 * where a global listener risks a `root` update and a `floatingPanels` update
 * landing in separate renders. `setPointerCapture` is called defensively
 * (`?.()`) because jsdom doesn't implement it — an unguarded call would throw
 * the instant a test dispatches a real `pointerdown`.
 *
 * The drag's *current* position is tracked in the drag ref itself, not read
 * back off the `panel` prop mid-drag — that prop reflects the last completed
 * render, which lags the position just written by the pointermove immediately
 * before a pointerup, and the drop-target hit test needs the real one.
 *
 * The redock button exists for a reason beyond convenience: dragging has no
 * keyboard equivalent, so it's also this window's only accessible path back
 * into a pane. It resolves to `panel.originLeafId` if that leaf still exists,
 * else falls back to whatever leaf is currently focused — the same
 * "fall back to something that still exists" pattern `workspace-context.tsx`
 * already uses for `focusedLeafId` after a `closeLeaf`.
 *
 * `bg-popover`/`border-input`, not `bg-card`/`border`: every docked pane's own
 * content already sits on `bg-card` (design-language.md's "surfaces climb in
 * ~2% steps" ladder), so a floating window painted the same step is
 * indistinguishable from the tiled pane behind it (live feedback — the two
 * were reading as one surface). `popover` is the next rung up, and `input`
 * is the brighter of the two border weights for the same reason a field
 * needs to announce itself before you click it — here it's a window
 * announcing that it's a separate, draggable surface, not part of the tree
 * underneath.
 */

import * as React from 'react';
import { Dock, X } from 'lucide-react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { useWorkspaceOverlay } from '@/components/resparkable/workspace/workspace-overlay-context';
import { TabContent } from '@/components/resparkable/workspace/tabs/tab-content';
import { findLeaf } from '@/lib/framework/resparkable/ui/workspace/split-tree';
import type { FloatingPanel } from '@/lib/framework/resparkable/ui/workspace/floating-panels';
import {
  defaultTitleForTab,
  TAB_REGISTRY,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface FloatingTabWindowProps {
  panel: FloatingPanel;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
}

interface ResizeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originWidth: number;
  originHeight: number;
}

export function FloatingTabWindow({ panel }: FloatingTabWindowProps): React.ReactElement {
  const workspace = useWorkspace();
  const overlay = useWorkspaceOverlay();
  const dragRef = React.useRef<DragState | null>(null);
  const resizeRef = React.useRef<ResizeState | null>(null);

  // A plain lookup, not `iconForTab(panel.tab.kind)` — same React Compiler
  // "no components created during render" reasoning `TabPill` documents.
  const Icon = TAB_REGISTRY[panel.tab.kind].icon;
  const label = panel.tab.title ?? defaultTitleForTab(panel.tab.kind);

  function redockTarget(): string {
    return findLeaf(workspace.root, panel.originLeafId)
      ? panel.originLeafId
      : workspace.focusedLeafId;
  }

  function onTitlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    workspace.focusFloatingPanel(panel.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: panel.x,
      originY: panel.y,
      currentX: panel.x,
      currentY: panel.y,
    };
  }

  function onTitlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = drag.originX + (event.clientX - drag.startClientX);
    const y = drag.originY + (event.clientY - drag.startClientY);
    drag.currentX = x;
    drag.currentY = y;
    workspace.moveFloatingPanel(panel.id, x, y);
  }

  function onTitlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    const centerX = drag.currentX + panel.width / 2;
    const centerY = drag.currentY + panel.height / 2;
    const leafId = overlay.findLeafAtPoint(centerX, centerY);
    if (leafId) workspace.dockPanel(panel.id, leafId);
  }

  function onResizePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    workspace.focusFloatingPanel(panel.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originWidth: panel.width,
      originHeight: panel.height,
    };
  }

  function onResizePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = resize.originWidth + (event.clientX - resize.startClientX);
    const height = resize.originHeight + (event.clientY - resize.startClientY);
    workspace.resizeFloatingPanel(panel.id, width, height);
  }

  function onResizePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!resizeRef.current || resizeRef.current.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  return (
    <div
      role="dialog"
      aria-label={label}
      onPointerDown={() => workspace.focusFloatingPanel(panel.id)}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: panel.z,
      }}
      className="border-input bg-popover pointer-events-auto absolute flex flex-col rounded-lg border shadow-2xl"
    >
      <div
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        className="border-input flex shrink-0 cursor-grab touch-none items-center gap-1.5 rounded-t-lg border-b px-2.5 py-1.5 select-none active:cursor-grabbing"
      >
        <Icon className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        {/* `onPointerDown` stops propagation on both controls — same guard
            `TabPill`'s close button uses — so clicking either doesn't also
            bubble into the title bar's own `onPointerDown` and start a drag
            (which would arm `setPointerCapture` on the title bar for a
            pointer that a plain click's matching pointerup would then also
            resolve as a drop). */}
        <button
          type="button"
          aria-label="Dock this tab"
          title="Dock this tab"
          onClick={() => workspace.dockPanel(panel.id, redockTarget())}
          onPointerDown={(event) => event.stopPropagation()}
          className="hover:bg-accent rounded-sm p-1"
        >
          <Dock className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={() => workspace.closeFloatingPanel(panel.id)}
          onPointerDown={(event) => event.stopPropagation()}
          className="hover:bg-accent rounded-sm p-1"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TabContent tab={panel.tab} />
      </div>

      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        aria-hidden="true"
        className="absolute right-0 bottom-0 h-5 w-5 cursor-nwse-resize touch-none rounded-br-lg"
        style={{
          backgroundImage:
            'linear-gradient(135deg, transparent 0 45%, var(--border) 45% 55%, transparent 55% 65%, var(--border) 65% 75%, transparent 75%)',
        }}
      />
    </div>
  );
}
