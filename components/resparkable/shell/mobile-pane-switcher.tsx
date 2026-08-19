'use client';

/**
 * MobilePaneSwitcher — the narrow-viewport fallback for the three fixed
 * panes, below `lg` (matching the rail's own precedent breakpoint —
 * `resparkable-nav.tsx`'s `lg:hidden` section switcher — rather than the
 * Risks section's "~900px" approximation of the same cutoff).
 *
 * Three fixed panes cost about 900px before any of them has room to be
 * useful (build plan, Risks) — there is no meaningful "collapse a little"
 * for this layout the way a single content column has. So this doesn't
 * shrink the three-pane `ResizablePanelGroup`; `WorkspaceShell` swaps to
 * this component entirely below the breakpoint, and this renders exactly
 * one of the three panes at a time, chosen here.
 *
 * ## All three panes stay mounted; only visibility toggles
 *
 * `SparkeyPane`'s draft/transcript and `ActivityPane`'s already-reviewed
 * set are plain component state — switching *away* from a pane must not
 * unmount it, or a half-written capture is gone the moment the presenter
 * checks Activity and comes back. Every pane in this file renders
 * unconditionally; only a `hidden` class toggles which one is visible.
 *
 * This guarantee holds only *within* a single mount of this component.
 * `WorkspaceShell` mounts either this or the desktop layout, never both —
 * resizing the window across the breakpoint therefore does unmount and
 * remount everything on the side that stops being shown, same as any
 * other `lg:hidden` swap in this app. A live resize losing an in-progress
 * capture is a real, accepted edge case, not a case this file defends
 * against.
 */

import * as React from 'react';
import { Boxes, Sparkles, Waves } from 'lucide-react';

import { ActivityPane } from '@/components/resparkable/activity/activity-pane';
import { SparkeyPane } from '@/components/resparkable/sparkey/sparkey-pane';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

type MobilePane = 'sparkey' | 'workspace' | 'activity';

const PANE_KEY = 'resparkable.workspace.mobilePane.v1';

const OPTIONS: Array<{
  value: MobilePane;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'sparkey', label: 'Sparkey', icon: Sparkles },
  { value: 'workspace', label: 'Workspace', icon: Boxes },
  { value: 'activity', label: 'Activity', icon: Waves },
];

export interface MobilePaneSwitcherProps {
  /** The route-tab-bridge-wrapped Workspace pane tree — rendered here, not fetched. */
  workspaceContent: React.ReactNode;
}

export function MobilePaneSwitcher({
  workspaceContent,
}: MobilePaneSwitcherProps): React.ReactElement {
  const [pane, setPane] = useLocalStorage<MobilePane>(PANE_KEY, 'workspace');

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="Pane" className="border-border/60 flex border-b">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = pane === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPane(option.value)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'border-primary text-foreground border-b-2'
                  : 'text-muted-foreground hover:text-foreground border-b-2 border-transparent'
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        <div className={cn('h-full', pane !== 'sparkey' && 'hidden')}>
          <SparkeyPane />
        </div>
        <div className={cn('h-full', pane !== 'workspace' && 'hidden')}>{workspaceContent}</div>
        <div className={cn('h-full', pane !== 'activity' && 'hidden')}>
          <ActivityPane />
        </div>
      </div>
    </div>
  );
}
