'use client';

/**
 * TabStrip — the row of open tabs at the top of one leaf pane.
 *
 * Draggable and keyboard-operable, the same `@dnd-kit/sortable` pattern
 * `task-card.tsx` uses on the board and for the same reason (§12's "works on
 * a phone, works from a keyboard" isn't optional). This `DndContext` is
 * still self-contained — a strip only ever *reorders* within itself, there's
 * no cross-pane drag mid-drag — so it's the whole `DndContext`/`SortableContext`
 * pair, not a slice of a page-level one.
 *
 * `onDragEnd` also detects the one thing that can happen *outside* that
 * context: dragging a tab clean out of the strip into its own floating
 * window (`workspace.detachTab`). `closestCenter` (this strip's own
 * collision detector) has no distance cutoff — with two or more tabs it
 * always resolves `over` to whichever tab is nearest, even when the pointer
 * is released far outside the strip entirely, so `over === null` is *not* a
 * reliable "dragged out" signal once there's more than one tab to be
 * "closest" to. `isPointInsideRect` against the strip's own `containerRef`
 * is therefore the authoritative detach check, run first and independent of
 * whatever `over` closestCenter came up with; only when the drop point is
 * still inside the strip does `over` get consulted, for reordering.
 *
 * The trailing "+" calls `showLauncher`, not `openTab`: it has nothing to
 * open yet, it just wants the launcher visible in this pane without
 * disturbing any tab already open in it.
 *
 * `DragOverlay` renders the one piece of feedback `useSortable`'s own
 * transform can't: a copy of the grabbed pill that tracks the pointer
 * free of the strip's `overflow-x-auto` clip and its `relative`-less
 * stacking context, so the "you're holding a tab" cue survives the moment
 * the pointer actually leaves the strip on the way to a detach — before
 * that it's dimmed in place same as any sortable-list drag. `dropAnimation:
 * null` because both landing spots already animate themselves: a reorder
 * settles via each `TabPill`'s own sortable transform, and a detach spawns
 * a `FloatingTabWindow` at the same point the overlay was just released —
 * an overlay snap-back in between would fight both.
 */

import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, X } from 'lucide-react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { useWorkspaceOverlay } from '@/components/resparkable/workspace/workspace-overlay-context';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import {
  defaultTitleForTab,
  TAB_REGISTRY,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import { isPointInsideRect } from '@/lib/framework/resparkable/ui/workspace/split-tree';
import { cn } from '@/lib/utils';

export interface TabStripProps {
  leafId: string;
  tabs: TabState[];
  activeTabId: string | null;
}

/** The center of a dnd-kit `ClientRect` (or a real `DOMRect`) — both share these four fields. */
function centerOfRect(rect: { left: number; right: number; top: number; bottom: number }): {
  x: number;
  y: number;
} {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

export function TabStrip({ leafId, tabs, activeTabId }: TabStripProps): React.ReactElement {
  const workspace = useWorkspace();
  const overlay = useWorkspaceOverlay();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function onDragStart(event: DragStartEvent): void {
    setDraggingTabId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent): void {
    setDraggingTabId(null);
    const { active, over } = event;

    // The authoritative "did this leave the strip" check — see the file
    // header comment on why `over === null` alone can't be trusted once the
    // strip holds more than one tab.
    const translated = active.rect.current.translated;
    const stripRect = containerRef.current?.getBoundingClientRect();
    const overlayRect = overlay.containerRef.current?.getBoundingClientRect();
    if (
      translated &&
      stripRect &&
      overlayRect &&
      !isPointInsideRect(centerOfRect(translated), stripRect)
    ) {
      workspace.detachTab(leafId, String(active.id), {
        x: translated.left - overlayRect.left,
        y: translated.top - overlayRect.top,
      });
      return;
    }

    if (!over || active.id === over.id) return;

    const toIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (toIndex === -1) return;
    workspace.reorderTab(leafId, String(active.id), toIndex);
  }

  const draggingTab = draggingTabId ? tabs.find((tab) => tab.id === draggingTabId) : undefined;

  return (
    <div ref={containerRef} className="border-border/60 flex items-center border-b">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingTabId(null)}
      >
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <ul className="flex min-w-0 items-center overflow-x-auto" aria-label="Open tabs">
            {tabs.map((tab) => (
              <TabPill
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onActivate={() => workspace.activateTab(leafId, tab.id)}
                onClose={() => workspace.closeTab(leafId, tab.id)}
              />
            ))}
          </ul>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {draggingTab ? <TabPillGhost tab={draggingTab} /> : null}
        </DragOverlay>
      </DndContext>

      <Tip label="Open something new">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground h-7 w-7 shrink-0"
          onClick={() => workspace.showLauncher(leafId)}
          aria-label="Open something new"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </Tip>
    </div>
  );
}

interface TabPillProps {
  tab: TabState;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabPill({ tab, active, onActivate, onClose }: TabPillProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const label = tab.title ?? defaultTitleForTab(tab.kind);
  // A plain lookup, not `iconForTab(tab.kind)` — `react-hooks/static-components`
  // (React Compiler's "no components created during render" rule) can't
  // prove an arbitrary function call returns a stable reference, but a
  // direct property read off a module-level constant is provably static,
  // the same pattern `ICON_MAP[item.kind]` uses elsewhere in the codebase.
  const Icon = TAB_REGISTRY[tab.kind].icon;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
    >
      <div
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={0}
        aria-current={active ? 'true' : undefined}
        aria-roledescription="draggable tab"
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
          }
        }}
        className={cn(
          'group flex max-w-48 min-w-0 cursor-grab items-center gap-1.5 border-r px-3 py-1.5 text-sm outline-none select-none',
          active
            ? 'bg-card text-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="hover:bg-muted rounded-sm p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** The `DragOverlay` preview for a grabbed tab — see the file header comment. */
function TabPillGhost({ tab }: { tab: TabState }): React.ReactElement {
  const label = tab.title ?? defaultTitleForTab(tab.kind);
  const Icon = TAB_REGISTRY[tab.kind].icon;

  return (
    <div className="bg-card flex max-w-48 min-w-0 -rotate-2 cursor-grabbing items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-lg">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}
