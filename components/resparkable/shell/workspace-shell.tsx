'use client';

/**
 * WorkspaceShell — the client half of the cutover `layout.tsx`.
 *
 * `layout.tsx` stays a Server Component so it can keep exporting `metadata`
 * (a 'use client' file can't) — this is everything below that: one
 * `WorkspaceProvider`, the sticky `ResparkableAppHeader`, and a responsive
 * choice between the desktop three-pane `ResizablePanelGroup` and
 * `MobilePaneSwitcher`, gated on `useMediaQuery` rather than pure CSS.
 *
 * ## Why this can't be the same dual-render-hide-with-CSS trick `resparkable-nav.tsx` uses
 *
 * That trick (render both, hide one with `lg:hidden`) is safe for a
 * stateless nav list — two copies of the same static markup agree by
 * construction. `SparkeyPane` and `ActivityPane` carry real component
 * state (a composer draft, an already-reviewed set); mounting each of them
 * *twice* — once in a hidden desktop layout, once in a hidden mobile one —
 * would give a user two independent copies of that state that silently
 * diverge. `useMediaQuery` picks exactly one layout to mount instead, at
 * the cost of the one-frame flash `use-media-query.ts`'s own header
 * comment already accepts.
 *
 * Present mode has no home here yet — `plan.md` §22.4 says outright that
 * how a presentation renders (a Workspace view? a distinct full-screen
 * mode?) isn't designed. `PresentPane` (Phase 7) stays unwired until that
 * question has an answer.
 */

import * as React from 'react';

import { RouteTabBridge } from '@/components/resparkable/shell/route-tab-bridge';
import { MobilePaneSwitcher } from '@/components/resparkable/shell/mobile-pane-switcher';
import { ResparkableAppHeader } from '@/components/resparkable/shell/app-header';
import { ActivityPane } from '@/components/resparkable/activity/activity-pane';
import { SparkeyPane } from '@/components/resparkable/sparkey/sparkey-pane';
import { WorkspaceProvider } from '@/components/resparkable/workspace/workspace-context';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

/** Matches `resparkable-nav.tsx`'s own `lg:hidden` breakpoint (1024px). */
const DESKTOP_QUERY = '(min-width: 1024px)';

export interface WorkspaceShellProps {
  children: React.ReactNode;
}

export function WorkspaceShell({ children }: WorkspaceShellProps): React.ReactElement {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  return (
    <WorkspaceProvider>
      {/* `/resparkable` sits in its own `(resparkable)` route group (see
          `layout.tsx`'s own header comment) specifically so nothing above
          `<body>` — no Sunrise `AppHeader`, no padded `<main>`, no footer —
          adds height this shell would have to subtract out. `h-dvh` is
          exact, not a guess: this really is the whole viewport. */}
      <div className="flex h-dvh flex-col">
        <ResparkableAppHeader />
        <div className="min-h-0 flex-1">
          {isDesktop ? (
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={22} minSize={15} maxSize={35}>
                <SparkeyPane />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={56} minSize={30}>
                <RouteTabBridge>{children}</RouteTabBridge>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={22} minSize={15} maxSize={35}>
                <ActivityPane />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <MobilePaneSwitcher workspaceContent={<RouteTabBridge>{children}</RouteTabBridge>} />
          )}
        </div>
      </div>
    </WorkspaceProvider>
  );
}
