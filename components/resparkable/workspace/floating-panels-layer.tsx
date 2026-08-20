'use client';

/**
 * FloatingPanelsLayer — renders every detached tab as its own
 * `FloatingTabWindow`, overlaid above the whole desktop shell.
 *
 * `pointer-events-none` on this wrapper, `pointer-events-auto` re-enabled on
 * each window itself: the gaps between floating windows must not swallow
 * clicks meant for the tiled panes underneath.
 *
 * `z-20` on this wrapper, not left at `auto`: each `FloatingTabWindow`'s own
 * `zIndex: panel.z` (`floating-panels.ts`'s `nextZIndex`) only orders
 * floating windows *against each other* — its own header comment says as
 * much ("not a literal CSS z-index") — and those values start at 1, well
 * under `PaneCollapseButton`'s `z-10`. Without a floor here, a docked pane's
 * collapse button painted in front of a detached tab sitting right behind
 * it (live feedback). `z-20` clears `z-10` but stays under the sticky
 * header's `z-40`, so Present mode's dialog and the header itself still win.
 */

import * as React from 'react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { FloatingTabWindow } from '@/components/resparkable/workspace/floating-tab-window';

export function FloatingPanelsLayer(): React.ReactElement {
  const workspace = useWorkspace();

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {workspace.floatingPanels.map((panel) => (
        <FloatingTabWindow key={panel.id} panel={panel} />
      ))}
    </div>
  );
}
