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
 * `renderTabContent` is a placeholder here, not a dispatcher — Phase 3 adds
 * one file per tab kind under `workspace/tabs/`, and wiring a kind → view
 * lookup table before those files exist would be dead code pointing at
 * nothing. This shows enough to smoke-test the pane mechanics (which tab is
 * active, does closing/splitting/resizing work) without depending on work
 * this phase doesn't include.
 */

import * as React from 'react';

import { Launcher } from '@/components/resparkable/workspace/launcher';
import { TabStrip } from '@/components/resparkable/workspace/tab-strip';
import { PaneToolbar } from '@/components/resparkable/workspace/toolbar';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import type { LeafNode, PaneNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';
import {
  defaultTitleForTab,
  type TabState,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface WorkspacePaneTreeProps {
  node: PaneNode;
}

export function WorkspacePaneTree({ node }: WorkspacePaneTreeProps): React.ReactElement {
  // Called unconditionally — `node.kind` can differ across renders of the
  // same mounted instance (a leaf's `splitLeaf` result reuses a fresh id
  // for the wrapping split, so React usually remounts on that transition,
  // but the hook rules apply regardless of what happens to hold in practice).
  const workspace = useWorkspace();

  if (node.kind === 'leaf') {
    return <WorkspacePane leaf={node} />;
  }

  return (
    <ResizablePanelGroup
      direction={node.direction}
      onLayout={(sizes) => workspace.resizeSplit(node.id, sizes)}
    >
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
      <div className="min-h-0 flex-1">
        {activeTab ? <TabContentPlaceholder tab={activeTab} /> : <Launcher leafId={leaf.id} />}
      </div>
    </div>
  );
}

/** Replaced by Phase 3's per-kind adapters under `workspace/tabs/`. */
function TabContentPlaceholder({ tab }: { tab: TabState }): React.ReactElement {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
      {tab.title ?? defaultTitleForTab(tab.kind)} — content adapter arrives in Phase 3.
    </div>
  );
}
