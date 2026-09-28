// @vitest-environment happy-dom

/**
 * Unit Tests: what each mount site binds `TabCloseProvider` to.
 *
 * `tab-close-context.test.tsx` covers the seam itself. This covers the part
 * that can actually be wrong: whether "close me" resolves to the right action
 * for where the tab lives. There are three answers and they are not
 * interchangeable:
 *
 * - a docked tab closes with `closeTab(leafId, tabId)`;
 * - a detached tab closes with `closeFloatingPanel(panelId)`, because it is no
 *   longer in the pane tree at all and a `closeTab` keyed on its stale
 *   `originLeafId` would silently do nothing;
 * - the route-backed tab gets **no** closer, because the browser URL is that
 *   tab's identity and its content navigates instead.
 *
 * `TabContent` is replaced with a probe that calls the hook, since the real
 * adapters render whatever the tab kind happens to be and none of them exposes
 * a close control. The assertion is end to end regardless: click inside the
 * tab's content, and the tab is gone from the strip.
 *
 * @see components/resparkable/workspace/tabs/tab-close-context.tsx
 */

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useOptionalTabClose } from '@/components/resparkable/workspace/tabs/tab-close-context';
import { FloatingTabWindow } from '@/components/resparkable/workspace/floating-tab-window';
import { WorkspacePaneTree } from '@/components/resparkable/workspace/workspace-pane-tree';
import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

/** Stands in for whatever a tab renders, and reports what the hook gave it. */
vi.mock('@/components/resparkable/workspace/tabs/tab-content', () => ({
  TabContent: () => {
    const close = useOptionalTabClose();
    return (
      <button type="button" onClick={() => close?.()}>
        {close ? 'close this tab' : 'no closer here'}
      </button>
    );
  },
}));

// `ResizablePanelGroup` needs real layout; the tree's own test file stubs it
// the same way.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

const ROOT_LEAF_ID = 'root';

function PaneHarness({ routeContent }: { routeContent?: React.ReactNode }): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;
  return (
    <div>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <button onClick={() => workspace.syncRouteTab('today')}>sync route to today</button>
      <button
        onClick={() =>
          leaf.tabs[0] && workspace.detachTab(ROOT_LEAF_ID, leaf.tabs[0].id, { x: 10, y: 20 })
        }
      >
        detach
      </button>
      <p data-testid="leaf-tab-count">{leaf.tabs.length}</p>
      <p data-testid="panel-count">{workspace.floatingPanels.length}</p>
      {workspace.floatingPanels[0] && <FloatingTabWindow panel={workspace.floatingPanels[0]} />}
      <WorkspacePaneTree node={workspace.root} routeContent={routeContent} />
    </div>
  );
}

function renderHarness(routeContent?: React.ReactNode) {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <PaneHarness routeContent={routeContent} />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('a docked tab', () => {
  it('closes itself from inside its own content', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: 'close this tab' }));

    // Gone from the pane's own tab list, which is `closeTab(leafId, tabId)`
    // having found the right leaf. A closer bound to the wrong leaf id would
    // leave the count at 1.
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');
  });
});

describe('a detached tab', () => {
  it('closes its floating window, not a tab in the tree', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('detach'));
    expect(screen.getByTestId('panel-count')).toHaveTextContent('1');
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');

    // The window renders the same `TabContent`, so the probe appears twice
    // only if the pane still holds a tab. It does not, so this is the
    // window's copy.
    await user.click(screen.getByRole('button', { name: 'close this tab' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
  });
});

describe('the route-backed tab', () => {
  it('is given no closer, because its content navigates instead', async () => {
    const user = userEvent.setup();
    renderHarness(<RouteProbe />);

    await user.click(screen.getByText('sync route to today'));

    expect(
      screen.getByRole('button', { name: 'route content: no closer here' })
    ).toBeInTheDocument();
  });
});

/** The same probe, standing in for the real server-rendered page. */
function RouteProbe(): React.ReactElement {
  const close = useOptionalTabClose();
  return (
    <button type="button" onClick={() => close?.()}>
      route content: {close ? 'close this tab' : 'no closer here'}
    </button>
  );
}
