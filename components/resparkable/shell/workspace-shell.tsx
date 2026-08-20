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
 * ## Present mode
 *
 * `plan.md` §22.4 left the render question open — "a Workspace view? a
 * distinct full-screen mode?" — until a `ResparkableAppHeader` "Present"
 * button gave it a real trigger to design against. Full-screen mode won:
 * `PresentPane` (Phase 7) renders inside `Dialog`/`DialogContent`
 * (`components/ui/dialog.tsx`, Radix underneath) rather than a fourth
 * `ResizablePanel` — a workspace tab would need `tab-registry.ts`, the
 * launcher, and `split-tree.ts` all taught about a kind that can't
 * meaningfully split or sit next to another pane, for a mode whose whole
 * point is to *not* share the screen. `DialogContent`'s own sizing classes
 * are overridden to fill the viewport (`inset-0 h-screen w-screen
 * max-w-none`, no translate-to-centre) rather than writing a bespoke
 * overlay — same Escape-to-close and focus trap every other dialog in the
 * app gets, and a portal render means it neither inherits nor fights
 * `Launcher`'s own `[contain:paint]` (added the same session, for an
 * unrelated bleed-through bug) or any pane's stacking context.
 *
 * `PresentPane`'s `payload` prop — "the currently-focused Graph tab's
 * payload" per that component's own header comment — is passed `null`
 * here rather than wired to a real Graph tab's data. Wiring it for real
 * means lifting `GraphTab`'s fetch out of that tab and into shared state
 * `PresentPane` can also read, which `GraphTab`'s own header comment
 * already flags as a separate, not-yet-done piece of work — not something
 * to improvise as a side effect of adding a Present button. `null` is a
 * real, already-handled state (`PresentPane`'s Deck mode shows "Open a
 * Graph tab and come back" for it), not a stand-in for a crash.
 *
 * ## Collapsing Sparkey and Activity into a drawer
 *
 * Both side panels are `collapsible`, with `collapsedSize={COLLAPSED_RAIL_SIZE}`
 * rather than 0 — collapsing takes a panel to a thin, still-visible rail
 * (`PaneRail`), not out of existence. That's deliberate: a panel that
 * shrinks to true 0 width takes its own content with it, including
 * whatever might re-expand it. `react-resizable-panels`' own snap
 * threshold (roughly halfway between `collapsedSize` and `minSize`) is
 * what makes dragging a handle past that point collapse or expand the
 * panel on its own; `expandSparkey`/`expandActivity` and each panel's own
 * `.collapse()` below do the same thing programmatically, wired to
 * `PaneCollapseButton` (floating on the `ResizableHandle` itself, via its
 * `children` slot) and to `PaneRail`'s whole-strip click. Neither pane
 * unmounts either way (the panel's `flex-basis` just changes, content
 * stays in the tree) — the same state-loss concern the header comment
 * above raises for the desktop/mobile split applies here too: a collapsed
 * Sparkey pane still owns the composer draft that would be lost on remount.
 *
 * `expandSparkey`/`expandActivity` call `.resize(SIDE_PANE_DEFAULT_SIZE)`
 * rather than `.expand()` deliberately — `.expand()` restores whatever
 * size the panel was dragged to *before* it collapsed, which after a
 * manual resize could be anything up to `maxSize`. A re-open should be
 * predictable, not a replay of wherever the drag happened to leave off.
 *
 * `sparkeyCollapsed`/`activityCollapsed` exist only so each pane knows
 * which of its own two JSX branches (full content vs. `PaneRail`) to
 * render; `ResparkableAppHeader` doesn't take part in this at all — a
 * first cut put the toggle buttons there and real usage flagged them as
 * disconnected from what they acted on (see that file's own header
 * comment).
 *
 * ## Why the pane area waits for `mounted`
 *
 * This shell's first client render leans on two deliberately-provisional
 * values: `useMediaQuery`'s guessed `isDesktop` and `WorkspaceProvider`'s
 * `useLocalStorage`-backed tree, both seeded from a hydration-safe default
 * rather than the real, stored one (see each hook's own header comment —
 * both call this "a one-frame flash" they accept on purpose). Each gets
 * corrected independently, in its own post-mount effect, which is normally
 * invisible. Under dev-mode overhead it isn't: live feedback caught the
 * correction stretching across a visible extra frame where the tiled panes'
 * *content* — Sparkey, Activity, the pane tree — had nothing painted yet,
 * while `ResizableHandle` and `PaneCollapseButton` (neither of which reads
 * either provisional value) kept rendering right through it, so the only
 * thing left on screen was two floating buttons.
 *
 * `mounted` collapses every one of those independent corrections into one
 * deliberate swap: `WorkspacePanesSkeleton` (`workspace-shell-skeleton.tsx`)
 * stands in for the whole pane area — same 22/56/22 shape the real one
 * settles into — until an effect flips `mounted` true, at which point the
 * real, now-correct tree mounts in a single commit instead of arriving
 * piecemeal. The header and footer aren't gated by this: neither reads a
 * provisional value, so neither has anything to visibly correct.
 */

import * as React from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { PaneCollapseButton } from '@/components/resparkable/shell/pane-collapse-button';
import { RouteTabBridge } from '@/components/resparkable/shell/route-tab-bridge';
import { MobilePaneSwitcher } from '@/components/resparkable/shell/mobile-pane-switcher';
import { ResparkableAppHeader } from '@/components/resparkable/shell/app-header';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { ActivityPane } from '@/components/resparkable/activity/activity-pane';
import { SparkeyPane } from '@/components/resparkable/sparkey/sparkey-pane';
import { PresentPane } from '@/components/resparkable/workspace/present/present-pane';
import { WorkspaceProvider } from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { FloatingPanelsLayer } from '@/components/resparkable/workspace/floating-panels-layer';
import { WorkspacePanesSkeleton } from '@/components/resparkable/shell/workspace-shell-skeleton';
import { SIDE_PANE_DEFAULT_SIZE } from '@/components/resparkable/shell/workspace-shell-constants';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

/** Matches `resparkable-nav.tsx`'s own `lg:hidden` breakpoint (1024px). */
const DESKTOP_QUERY = '(min-width: 1024px)';

/** A rail wide enough for `PaneRail`'s chevron and vertical label. */
const COLLAPSED_RAIL_SIZE = 4;

interface CollapsibleSidePanelProps {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  side: 'left' | 'right';
  label: string;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * Sparkey and Activity are mirror images of the same "resizable panel + its
 * own collapse handle" unit — same sizing/collapse props, differing only by
 * which side of the shell they sit on. The handle's position relative to the
 * panel flips with `side`, though: it always sits on the edge nearest the
 * centre pane (after the panel on the left, before it on the right), so the
 * `ResizablePanelGroup` still sees panels and handles alternating correctly.
 */
function CollapsibleSidePanel({
  panelRef,
  side,
  label,
  collapsed,
  onCollapse,
  onExpand,
  onToggle,
  children,
}: CollapsibleSidePanelProps): React.ReactElement {
  const panel = (
    <ResizablePanel
      ref={panelRef}
      defaultSize={SIDE_PANE_DEFAULT_SIZE}
      minSize={15}
      maxSize={35}
      collapsible
      collapsedSize={COLLAPSED_RAIL_SIZE}
      onCollapse={onCollapse}
      onExpand={onExpand}
    >
      {children}
    </ResizablePanel>
  );
  const handle = (
    <ResizableHandle>
      <PaneCollapseButton side={side} label={label} collapsed={collapsed} onToggle={onToggle} />
    </ResizableHandle>
  );
  return side === 'left' ? (
    <>
      {panel}
      {handle}
    </>
  ) : (
    <>
      {handle}
      {panel}
    </>
  );
}

export interface WorkspaceShellProps {
  children: React.ReactNode;
}

export function WorkspaceShell({ children }: WorkspaceShellProps): React.ReactElement {
  // `initialValue: true` — this shell's three-pane layout is the desktop
  // case, so the SSR/first-render guess (see `useMediaQuery`'s own header
  // comment) should land there, not on `MobilePaneSwitcher`'s full-width
  // single pane. A mismatch still flashes on the rarer narrow-viewport
  // load; the reverse (guessing mobile) flashed the wrong layout on every
  // desktop load, which is the common case for this shell.
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const sparkeyPanelRef = React.useRef<ImperativePanelHandle>(null);
  const activityPanelRef = React.useRef<ImperativePanelHandle>(null);
  const [sparkeyCollapsed, setSparkeyCollapsed] = React.useState(false);
  const [activityCollapsed, setActivityCollapsed] = React.useState(false);
  const [presenting, setPresenting] = React.useState(false);
  // See "Why the pane area waits for `mounted`" above. `useMediaQuery` and
  // `useLocalStorage` both intentionally start from a provisional value on
  // this first render, so the real pane tree isn't trustworthy to paint
  // until their corrections have landed.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  function expandSparkey(): void {
    sparkeyPanelRef.current?.resize(SIDE_PANE_DEFAULT_SIZE);
  }

  function expandActivity(): void {
    activityPanelRef.current?.resize(SIDE_PANE_DEFAULT_SIZE);
  }

  return (
    <WorkspaceProvider>
      {/* `/resparkable` sits in its own `(resparkable)` route group (see
          `layout.tsx`'s own header comment) specifically so nothing above
          `<body>` — no Sunrise `AppHeader`, no padded `<main>` — adds height
          this shell would have to subtract out. `h-dvh` is exact, not a
          guess: this really is the whole viewport. `ProtectedFooter` is
          back (live feedback after the post-cutover fixes dropped it) as a
          flex sibling of the pane area rather than page content below a
          scroll: `flex-1 min-h-0` on the pane row means the footer's own
          height is simply subtracted from it, no calc() guess needed. */}
      <div className="flex h-dvh flex-col">
        <ResparkableAppHeader onPresent={() => setPresenting(true)} />
        <div className="min-h-0 flex-1">
          {/* Wraps both branches, not just the desktop one: `WorkspacePane`
              calls `useWorkspaceOverlay()` unconditionally, and
              `MobilePaneSwitcher` renders the same `RouteTabBridge`-wrapped
              pane tree desktop does — only `FloatingPanelsLayer` itself is
              desktop-only. */}
          <WorkspaceOverlayProvider>
            {!mounted ? (
              <WorkspacePanesSkeleton />
            ) : isDesktop ? (
              <>
                <ResizablePanelGroup direction="horizontal">
                  <CollapsibleSidePanel
                    panelRef={sparkeyPanelRef}
                    side="left"
                    label="Sparkey"
                    collapsed={sparkeyCollapsed}
                    onCollapse={() => setSparkeyCollapsed(true)}
                    onExpand={() => setSparkeyCollapsed(false)}
                    onToggle={() =>
                      sparkeyCollapsed ? expandSparkey() : sparkeyPanelRef.current?.collapse()
                    }
                  >
                    <SparkeyPane collapsed={sparkeyCollapsed} onExpand={expandSparkey} />
                  </CollapsibleSidePanel>
                  <ResizablePanel defaultSize={56} minSize={30}>
                    <RouteTabBridge>{children}</RouteTabBridge>
                  </ResizablePanel>
                  <CollapsibleSidePanel
                    panelRef={activityPanelRef}
                    side="right"
                    label="Activity"
                    collapsed={activityCollapsed}
                    onCollapse={() => setActivityCollapsed(true)}
                    onExpand={() => setActivityCollapsed(false)}
                    onToggle={() =>
                      activityCollapsed ? expandActivity() : activityPanelRef.current?.collapse()
                    }
                  >
                    <ActivityPane collapsed={activityCollapsed} onExpand={expandActivity} />
                  </CollapsibleSidePanel>
                </ResizablePanelGroup>
                <FloatingPanelsLayer />
              </>
            ) : (
              <MobilePaneSwitcher workspaceContent={<RouteTabBridge>{children}</RouteTabBridge>} />
            )}
          </WorkspaceOverlayProvider>
        </div>
        <ProtectedFooter />
      </div>

      <Dialog open={presenting} onOpenChange={setPresenting}>
        <DialogContent className="inset-0 top-0 left-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:rounded-none">
          <DialogTitle className="sr-only">Present</DialogTitle>
          <PresentPane payload={null} />
        </DialogContent>
      </Dialog>
    </WorkspaceProvider>
  );
}
