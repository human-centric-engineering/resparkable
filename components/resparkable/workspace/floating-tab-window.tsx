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
 * underneath. The title bar's two buttons hover on `bg-accent`, not the
 * `bg-muted` most icon buttons use elsewhere — `muted` (#14161e) sits one
 * unit off `popover` (#14161f) and would hover-highlight to effectively
 * nothing on this particular surface.
 *
 * `.floating-window` (`brand-theme.css`) stands in for Tailwind's
 * `shadow-2xl` — that off-the-shelf shadow is tuned for a white page and
 * disappears against `--color-background: #0a0b0f` (live feedback, again).
 * See its comment in `brand-theme.css` for the fix.
 *
 * ## Persisting the drag/resize is debounced; following the pointer isn't
 *
 * `workspace.moveFloatingPanel`/`resizeFloatingPanel` are `useLocalStorage`-backed
 * — every call synchronously serializes and writes the *entire* workspace tree
 * (every pane, every tab, every floating panel) and dispatches a storage
 * `CustomEvent`. Calling either on every `pointermove` tick, as a naive
 * implementation does, is jank proportional to total tab/pane count, not to
 * the one window being dragged — the exact problem `workspace-pane-tree.tsx`'s
 * `useDebouncedResizeSplit` already solves for split-resize, mirrored here.
 *
 * The window still has to visually follow the pointer at full rate, so
 * `liveRect` renders the in-progress position/size directly (bypassing
 * `panel.x/y/width/height`, which now only reflect the last *persisted*
 * state) while `schedulePersist` debounces the actual `moveFloatingPanel`/
 * `resizeFloatingPanel` write. `flushPersist` forces that write through
 * immediately on release, so the gesture's true end state is never lost to
 * a pending debounce timer, and `liveRect` clears back to `null` in the same
 * batch — `panel.x/y/width/height` has already caught up by the render that
 * follows, so there's no visible snap-back.
 */

import * as React from 'react';
import { Dock, X } from 'lucide-react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { useWorkspaceOverlay } from '@/components/resparkable/workspace/workspace-overlay-context';
import { TabContent } from '@/components/resparkable/workspace/tabs/tab-content';
import { Tip } from '@/components/ui/tooltip';
import { findLeaf } from '@/lib/framework/resparkable/ui/workspace/split-tree';
import {
  MIN_FLOATING_PANEL_HEIGHT,
  MIN_FLOATING_PANEL_WIDTH,
  type FloatingPanel,
} from '@/lib/framework/resparkable/ui/workspace/floating-panels';
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
  currentWidth: number;
  currentHeight: number;
}

interface LiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Matches `workspace-pane-tree.tsx`'s `RESIZE_PERSIST_DEBOUNCE_MS` — same tradeoff, same cadence. */
const PERSIST_DEBOUNCE_MS = 150;

export function FloatingTabWindow({ panel }: FloatingTabWindowProps): React.ReactElement {
  const workspace = useWorkspace();
  const overlay = useWorkspaceOverlay();
  const dragRef = React.useRef<DragState | null>(null);
  const resizeRef = React.useRef<ResizeState | null>(null);
  const [liveRect, setLiveRect] = React.useState<LiveRect | null>(null);
  const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    },
    []
  );

  function schedulePersist(write: () => void): void {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(write, PERSIST_DEBOUNCE_MS);
  }

  function flushPersist(write: () => void): void {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    write();
  }

  // A plain lookup, not `iconForTab(panel.tab.kind)` — same React Compiler
  // "no components created during render" reasoning `TabPill` documents.
  const Icon = TAB_REGISTRY[panel.tab.kind].icon;
  const label = panel.tab.title ?? defaultTitleForTab(panel.tab.kind);
  const rect: LiveRect = liveRect ?? {
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
  };

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
    let x = drag.originX + (event.clientX - drag.startClientX);
    let y = drag.originY + (event.clientY - drag.startClientY);

    // Clamped here, not in `floating-panels.ts` — see that module's header
    // comment: this needs the overlay's live, measured container size, which
    // is runtime knowledge only this component (via `useWorkspaceOverlay()`)
    // has. Guarded on a real (non-zero) measurement rather than applied
    // unconditionally: happy-dom's `getBoundingClientRect()` always reports a
    // zeroed rect (no layout engine), which would otherwise pin every drag to
    // (0,0) under test. Skipping the clamp on an unmeasured container is safe
    // in production too — a window can't be dragged before the shell around
    // it has laid out.
    const containerRect = overlay.containerRef.current?.getBoundingClientRect();
    if (containerRect && containerRect.width > 0 && containerRect.height > 0) {
      const maxX = Math.max(0, containerRect.width - panel.width);
      const maxY = Math.max(0, containerRect.height - panel.height);
      x = Math.min(Math.max(x, 0), maxX);
      y = Math.min(Math.max(y, 0), maxY);
    }

    drag.currentX = x;
    drag.currentY = y;
    setLiveRect({ x, y, width: panel.width, height: panel.height });
    schedulePersist(() => workspace.moveFloatingPanel(panel.id, x, y));
  }

  function onTitlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    flushPersist(() => workspace.moveFloatingPanel(panel.id, drag.currentX, drag.currentY));
    setLiveRect(null);

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
      currentWidth: panel.width,
      currentHeight: panel.height,
    };
  }

  function onResizePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    // Clamped to the same minimum `resizeFloatingPanel` itself enforces —
    // that clamp used to be visible live because every tick round-tripped
    // through the reducer; matched here so debouncing that write doesn't
    // let the live-follow render dip below it before the next persist catches up.
    const width = Math.max(
      resize.originWidth + (event.clientX - resize.startClientX),
      MIN_FLOATING_PANEL_WIDTH
    );
    const height = Math.max(
      resize.originHeight + (event.clientY - resize.startClientY),
      MIN_FLOATING_PANEL_HEIGHT
    );
    resize.currentWidth = width;
    resize.currentHeight = height;
    setLiveRect({ x: panel.x, y: panel.y, width, height });
    schedulePersist(() => workspace.resizeFloatingPanel(panel.id, width, height));
  }

  function onResizePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    flushPersist(() =>
      workspace.resizeFloatingPanel(panel.id, resize.currentWidth, resize.currentHeight)
    );
    setLiveRect(null);
  }

  return (
    <div
      role="dialog"
      aria-label={label}
      onPointerDown={() => workspace.focusFloatingPanel(panel.id)}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: panel.z,
      }}
      className="floating-window border-input bg-popover pointer-events-auto absolute flex flex-col rounded-lg border"
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
        <Tip label="Dock this tab">
          <button
            type="button"
            aria-label="Dock this tab"
            onClick={() => workspace.dockPanel(panel.id, redockTarget())}
            onPointerDown={(event) => event.stopPropagation()}
            className="hover:bg-accent rounded-sm p-1"
          >
            <Dock className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tip>
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

      {/* `bg-background`, not the window's own `bg-popover` — the same
          `TabContent` renders docked, where its pane is `bg-background`
          (`workspace-pane-tree.tsx`) precisely so its own `bg-card` boxes
          climb the surface ladder and stay visible. Floating shouldn't
          re-flatten them; the popover shade stays confined to this padded
          frame around the content, doing the "distinct from the shell"
          job it was added for without doing it twice to what's inside. */}
      <div className="bg-background min-h-0 flex-1 overflow-y-auto p-3">
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
