'use client';

/**
 * TabStrip — the row of open tabs at the top of one leaf pane.
 *
 * Draggable and keyboard-operable, the same `@dnd-kit/sortable` pattern
 * `task-card.tsx` uses on the board and for the same reason (§12's "works on
 * a phone, works from a keyboard" isn't optional). Unlike the board, this
 * `DndContext` is self-contained — a strip only ever reorders within
 * itself, there's no cross-pane drag in this phase — so it's the whole
 * `DndContext`/`SortableContext` pair, not a slice of a page-level one.
 *
 * The trailing "+" calls `showLauncher`, not `openTab`: it has nothing to
 * open yet, it just wants the launcher visible in this pane without
 * disturbing any tab already open in it.
 */

import * as React from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { defaultTitleForTab } from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import { cn } from '@/lib/utils';

export interface TabStripProps {
  leafId: string;
  tabs: TabState[];
  activeTabId: string | null;
}

export function TabStrip({ leafId, tabs, activeTabId }: TabStripProps): React.ReactElement {
  const workspace = useWorkspace();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const toIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (toIndex === -1) return;
    workspace.reorderTab(leafId, String(active.id), toIndex);
  }

  return (
    <div className="border-border/60 flex items-center border-b">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <ul className="flex min-w-0 flex-1 items-center overflow-x-auto" aria-label="Open tabs">
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
