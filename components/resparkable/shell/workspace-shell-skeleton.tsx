/**
 * WorkspaceShellSkeleton / WorkspacePanesSkeleton — placeholders shaped like
 * the real `WorkspaceShell`, for the two moments nothing else is standing in
 * for it yet:
 *
 * - `WorkspaceShellSkeleton` (header + panes) is `layout.tsx`'s `Suspense`
 *   fallback for `MaintenanceWrapperWithAdminNotice` (an async Server
 *   Component — a DB read plus a session check — un-Suspended before this).
 * - `WorkspacePanesSkeleton` (panes only) is what `workspace-shell.tsx`
 *   itself renders in place of the real `ResizablePanelGroup`/
 *   `MobilePaneSwitcher` branch until its own `mounted` flag flips true —
 *   see that file's header comment for why the real tree's first client
 *   render can't be trusted to paint fully formed.
 *
 * Both are shaped like the real shell — Sparkey / Workspace / Activity at
 * the same 22/56/22 split `SIDE_PANE_DEFAULT_SIZE` uses — rather than a
 * generic centred spinner, so the three segments actually arriving (chat/
 * capture, the tab tree, the discovery feed) each get their own placeholder
 * instead of one undifferentiated blank. `flexBasis` percentages, not
 * `ResizablePanelGroup`: neither fallback ever has to be resizable, and
 * pulling in `react-resizable-panels` for a shape that's about to be
 * replaced wholesale would cost more than it explains.
 */

import { Skeleton, SkeletonBlock } from '@/components/resparkable/ui/skeleton';
import { SIDE_PANE_DEFAULT_SIZE } from '@/components/resparkable/shell/workspace-shell';

const SIDE_PANE_FLEX_BASIS = `${SIDE_PANE_DEFAULT_SIZE}%`;
const CENTER_PANE_FLEX_BASIS = `${100 - 2 * SIDE_PANE_DEFAULT_SIZE}%`;

export function WorkspacePanesSkeleton(): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1">
      {/* Sparkey: header, a couple of transcript bubbles, the composer bar. */}
      <div
        className="flex h-full min-w-0 flex-col border-r"
        style={{ flexBasis: SIDE_PANE_FLEX_BASIS }}
      >
        <div className="flex items-center justify-center gap-2 border-b px-3 py-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex-1 space-y-3 p-3">
          <Skeleton className="h-10 w-4/5" />
          <Skeleton className="ml-auto h-10 w-3/5" />
        </div>
        <div className="border-t p-3">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>

      {/* Workspace: toolbar, then a launcher-shaped tile grid. */}
      <div
        className="@container flex h-full min-w-0 flex-col"
        style={{ flexBasis: CENTER_PANE_FLEX_BASIS }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Skeleton className="h-6 w-24" />
        </div>
        <div className="grid flex-1 grid-cols-1 content-start gap-3 p-6 @sm:grid-cols-2 @2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-lg" />
          ))}
        </div>
      </div>

      {/* Activity: header, a few discovery-card-shaped rows. */}
      <div
        className="flex h-full min-w-0 flex-col border-l"
        style={{ flexBasis: SIDE_PANE_FLEX_BASIS }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="flex-1 space-y-2 p-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceShellSkeleton(): React.ReactElement {
  return (
    <SkeletonBlock label="Loading your workspace" className="flex h-dvh flex-col">
      <div className="border-border/60 lattice-chrome sticky top-0 z-40 flex items-center gap-4 border-b px-3 py-2">
        <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
        <Skeleton className="h-8 w-full max-w-xs" />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </div>
      <WorkspacePanesSkeleton />
    </SkeletonBlock>
  );
}
