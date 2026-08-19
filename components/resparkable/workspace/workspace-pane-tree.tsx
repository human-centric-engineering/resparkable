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
 * unmodified.
 */

import * as React from 'react';

import { Launcher } from '@/components/resparkable/workspace/launcher';
import { TabStrip } from '@/components/resparkable/workspace/tab-strip';
import { TabContent } from '@/components/resparkable/workspace/tabs/tab-content';
import { PaneToolbar } from '@/components/resparkable/workspace/toolbar';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import type { LeafNode, PaneNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

export interface WorkspacePaneTreeProps {
  node: PaneNode;
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

export function WorkspacePaneTree({ node }: WorkspacePaneTreeProps): React.ReactElement {
  // Called unconditionally — `node.kind` can differ across renders of the
  // same mounted instance (a leaf's `splitLeaf` result reuses a fresh id
  // for the wrapping split, so React usually remounts on that transition,
  // but the hook rules apply regardless of what happens to hold in practice).
  const workspace = useWorkspace();
  const splitId = node.kind === 'split' ? node.id : null;
  const onLayout = useDebouncedResizeSplit(splitId ?? '', workspace.resizeSplit);

  if (node.kind === 'leaf') {
    return <WorkspacePane leaf={node} />;
  }

  return (
    <ResizablePanelGroup direction={node.direction} onLayout={onLayout}>
      {node.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index > 0 && <ResizableHandle withHandle />}
          <ResizablePanel defaultSize={node.sizes[index]} minSize={15}>
            <WorkspacePaneTree node={child} />
          </ResizablePanel>
        </React.Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function WorkspacePane({ leaf }: { leaf: LeafNode }): React.ReactElement {
  const activeTab = leaf.tabs.find((tab) => tab.id === leaf.activeTabId) ?? null;

  return (
    <div className="bg-card flex h-full flex-col">
      <PaneToolbar leafId={leaf.id} />
      {leaf.tabs.length > 0 && (
        <TabStrip leafId={leaf.id} tabs={leaf.tabs} activeTabId={leaf.activeTabId} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab ? <TabContent tab={activeTab} /> : <Launcher leafId={leaf.id} />}
      </div>
    </div>
  );
}
