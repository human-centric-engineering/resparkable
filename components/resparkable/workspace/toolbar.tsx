'use client';

/**
 * PaneToolbar — the three actions that operate on a whole pane rather than
 * on any one of its tabs: split right, split down, close pane. Sits above
 * the tab strip in every leaf `WorkspacePaneTree` renders.
 *
 * "Close pane" is disabled rather than hidden when this is the only leaf in
 * the tree. `closeLeaf` is already a safe no-op on the last pane (see
 * `split-tree.ts`), but a live button that silently does nothing reads as
 * broken; disabling it says why before the click.
 */

import * as React from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, XSquare } from 'lucide-react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { listLeaves } from '@/lib/framework/resparkable/ui/workspace/split-tree';

export interface PaneToolbarProps {
  leafId: string;
}

export function PaneToolbar({ leafId }: PaneToolbarProps): React.ReactElement {
  const workspace = useWorkspace();
  const canClose = listLeaves(workspace.root).length > 1;

  return (
    <div className="border-border/60 flex items-center justify-end gap-0.5 border-b px-1 py-0.5">
      <ToolbarButton
        label="Split right"
        onClick={() => workspace.splitLeaf(leafId, 'horizontal')}
        icon={SplitSquareHorizontal}
      />
      <ToolbarButton
        label="Split down"
        onClick={() => workspace.splitLeaf(leafId, 'vertical')}
        icon={SplitSquareVertical}
      />
      <ToolbarButton
        label="Close pane"
        onClick={() => workspace.closeLeaf(leafId)}
        icon={XSquare}
        disabled={!canClose}
      />
    </div>
  );
}

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

function ToolbarButton({
  label,
  onClick,
  icon: Icon,
  disabled,
}: ToolbarButtonProps): React.ReactElement {
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground h-6 w-6"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </Tip>
  );
}
