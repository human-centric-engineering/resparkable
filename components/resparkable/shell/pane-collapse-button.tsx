'use client';

/**
 * PaneCollapseButton — the collapse/expand toggle that lives on the
 * `ResizableHandle` between Sparkey/Workspace and Workspace/Activity, not
 * inside either pane's own header. A first cut put a "Collapse Sparkey"
 * chevron in `SparkeyPane`'s own header row when expanded — real usage
 * flagged that as disconnected from the drag handle a person actually
 * reaches for to resize the same pane. One button, on the handle, covers
 * both directions instead: the chevron points toward the shell's centre
 * (collapsed → click expands) or away from it (expanded → click collapses).
 *
 * `onPointerDown` stops propagation so a click registers as a click, not
 * the start of a drag — `PanelResizeHandle` (the handle this renders
 * inside, via its `children` slot) listens for pointer-down on itself to
 * begin dragging, and this button is physically inside that element.
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface PaneCollapseButtonProps {
  /** Which side of the shell the pane this handle borders sits on. */
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}

export function PaneCollapseButton({
  side,
  collapsed,
  onToggle,
  label,
}: PaneCollapseButtonProps): React.ReactElement {
  const towardCentre = side === 'left' ? ChevronRight : ChevronLeft;
  const towardEdge = side === 'left' ? ChevronLeft : ChevronRight;
  const Chevron = collapsed ? towardCentre : towardEdge;
  const actionLabel = collapsed ? `Show ${label}` : `Collapse ${label}`;

  return (
    <button
      type="button"
      onClick={onToggle}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={actionLabel}
      title={actionLabel}
      className="bg-card text-muted-foreground hover:text-foreground hover:border-primary/50 z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors"
    >
      <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
