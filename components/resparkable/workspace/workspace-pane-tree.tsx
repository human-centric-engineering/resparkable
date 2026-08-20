'use client';

/**
 * WorkspacePaneTree — walks `split-tree.ts`'s `PaneNode` and renders it.
 *
 * One recursion per `split` node, each wrapped in a `ResizablePanelGroup`
 * along the node's own `direction` — this is the entire mechanism behind
 * "split a pane that's already split" being arbitrarily deep for free (see
 * `split-tree.ts`'s header comment). A `leaf` renders as one pane: the
 * toolbar, the tab strip (if it has any tabs), and either the active tab's
 * content or the launcher.
 *
 * Active-tab content is `TabContent` (`workspace/tabs/tab-content.tsx`,
 * Phase 3) — one adapter per tab kind, each porting an existing page's
 * fetch to the client and rendering that page's existing View component
 * unmodified. The one exception is the tree's single `source: 'route'` tab
 * (see `split-tree.ts`'s `setRouteTab`): when it's the leaf's active tab,
 * `WorkspacePane` renders `routeContent` instead of `TabContent` — the
 * real, server-rendered `{children}` `route-tab-bridge.tsx` (Phase 8) is
 * already holding for exactly this route, not a second client-side fetch
 * of the same page.
 *
 * `routeContent` is threaded straight through the split recursion (each
 * `split` node just passes it on unchanged) rather than carried by a
 * context, since at most one leaf in the whole tree ever actually uses it.
 */

import * as React from 'react';

import { Launcher } from '@/components/resparkable/workspace/launcher';
import { TabStrip } from '@/components/resparkable/workspace/tab-strip';
import { TabContent } from '@/components/resparkable/workspace/tabs/tab-content';
import { PaneToolbar } from '@/components/resparkable/workspace/toolbar';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { useWorkspaceOverlay } from '@/components/resparkable/workspace/workspace-overlay-context';
import { SectionHeader } from '@/components/resparkable/layout/section-header';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { buildRouteForTab } from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import type { LeafNode, PaneNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

export interface WorkspacePaneTreeProps {
  node: PaneNode;
  /** The real, server-rendered content for the tree's one route-backed tab. */
  routeContent?: React.ReactNode;
}

/**
 * `react-resizable-panels` fires `onLayout` on every pointermove tick during
 * a drag, not just on release — the panels themselves resize live and
 * uncontrolled (`defaultSize` seeds the initial size only), so debouncing
 * this write costs nothing visually. Without it, `resizeSplit` serializes
 * and writes the whole workspace tree to `localStorage` on every tick of
 * every drag — jank proportional to total tab/pane count, not to the one
 * split being resized.
 */
const RESIZE_PERSIST_DEBOUNCE_MS = 150;

function useDebouncedResizeSplit(
  splitId: string,
  resizeSplit: (splitId: string, sizes: number[]) => void
): (sizes: number[]) => void {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always calls the latest `resizeSplit` without needing it in the
  // callback's own deps — it's recreated on every workspace state change,
  // not only when this split's own sizes change. Updated in an effect
  // rather than during render, which React (Compiler) forbids for refs.
  const resizeSplitRef = React.useRef(resizeSplit);
  React.useEffect(() => {
    resizeSplitRef.current = resizeSplit;
  }, [resizeSplit]);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return React.useCallback(
    (sizes: number[]) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        resizeSplitRef.current(splitId, sizes);
      }, RESIZE_PERSIST_DEBOUNCE_MS);
    },
    [splitId]
  );
}

export function WorkspacePaneTree({
  node,
  routeContent,
}: WorkspacePaneTreeProps): React.ReactElement {
  // Called unconditionally — `node.kind` can differ across renders of the
  // same mounted instance (a leaf's `splitLeaf` result reuses a fresh id
  // for the wrapping split, so React usually remounts on that transition,
  // but the hook rules apply regardless of what happens to hold in practice).
  const workspace = useWorkspace();
  const splitId = node.kind === 'split' ? node.id : null;
  const onLayout = useDebouncedResizeSplit(splitId ?? '', workspace.resizeSplit);

  if (node.kind === 'leaf') {
    return <WorkspacePane leaf={node} routeContent={routeContent} />;
  }

  return (
    <ResizablePanelGroup direction={node.direction} onLayout={onLayout}>
      {node.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index > 0 && <ResizableHandle withHandle />}
          <ResizablePanel defaultSize={node.sizes[index]} minSize={15}>
            <WorkspacePaneTree node={child} routeContent={routeContent} />
          </ResizablePanel>
        </React.Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function WorkspacePane({
  leaf,
  routeContent,
}: {
  leaf: LeafNode;
  routeContent?: React.ReactNode;
}): React.ReactElement {
  const activeTab = leaf.tabs.find((tab) => tab.id === leaf.activeTabId) ?? null;
  const isRouteTab = activeTab?.source === 'route';
  // `buildRouteForTab` returns a full, navigable href — Graph's and
  // Search's carry a query string (`?focusType=…&focus=…`, `?q=…`) that
  // `SectionHeader`'s lookup (`findSectionHelp`, plain-pathname matching)
  // was never meant to see; stripping it here is what keeps a focused
  // Graph tab or a search result finding their own header.
  const rawHref = activeTab ? buildRouteForTab(activeTab.kind, activeTab.params) : null;
  const href = rawHref?.split('?')[0];

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  const overlay = useWorkspaceOverlay();
  const hasTabs = leaf.tabs.length > 0;
  // Registered once per pane. When the pane has open tabs, only the tab
  // strip itself (`headerRef`) is the redock target — dropping a floating
  // window anywhere over a pane's *content* used to redock it, which made
  // dragging the window around the workspace at all feel like it was
  // constantly about to get swallowed. An empty pane has no tab strip to aim
  // at, so it falls back to its whole area (`containerRef`) — the same
  // `showLauncher` no-active-tab case this used to handle unconditionally.
  React.useEffect(
    () =>
      overlay.registerLeafRect(leaf.id, () => {
        const target = hasTabs ? headerRef.current : containerRef.current;
        return target?.getBoundingClientRect() ?? null;
      }),
    [overlay, leaf.id, hasTabs]
  );

  return (
    // `bg-background`, matching `SparkeyPane`/`ActivityPane` — not `bg-card`,
    // which this leaf ran until it was caught live: every tab's own content
    // boxes (`Card`, `thought-card.tsx`, `VaultExportCard`) are themselves
    // `bg-card`, so on a `bg-card` pane they painted the identical shade as
    // their background and only their 1px border showed. A pane is this
    // tab's page, not a card on one — content climbs the surface ladder
    // correctly once the pane itself sits at the bottom rung.
    <div ref={containerRef} className="bg-background flex h-full flex-col">
      <PaneToolbar leafId={leaf.id} />
      {hasTabs && (
        <div ref={headerRef}>
          <TabStrip leafId={leaf.id} tabs={leaf.tabs} activeTabId={leaf.activeTabId} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab ? (
          <div className="space-y-4 p-4">
            {/* `href` is `undefined` for a non-route-backed tab (`note`) —
                `SectionHeader` would otherwise fall back to its own default
                (`usePathname()`, the *browser's* URL), showing whichever
                route-backed tab the address bar happens to match instead of
                no header at all. */}
            {href && <SectionHeader href={href} />}
            {isRouteTab && routeContent ? routeContent : <TabContent tab={activeTab} />}
          </div>
        ) : (
          <Launcher leafId={leaf.id} />
        )}
      </div>
    </div>
  );
}
