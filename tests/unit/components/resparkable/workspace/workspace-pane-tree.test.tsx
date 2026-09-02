// @vitest-environment happy-dom

/**
 * Unit Tests: WorkspacePaneTree.
 *
 * Covers the render-time decision this file exists to make: a leaf shows
 * the launcher or its active tab depending on `activeTabId`, and a split
 * recurses into a nested `ResizablePanelGroup` per child, one level for
 * each level of nesting.
 *
 * `apiClient.get` is mocked to a promise that never resolves, so every
 * `TabContent` adapter sits in its loading state deterministically — this
 * file is about which pane shows *what kind of thing* (launcher vs. tab
 * content vs. a second independent pane), not about any one adapter's own
 * fetch/error/data behavior, which belongs to that adapter's own test.
 *
 * @see components/resparkable/workspace/workspace-pane-tree.tsx
 */

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
} from '@/components/resparkable/workspace/workspace-overlay-context';
import { WorkspacePaneTree } from '@/components/resparkable/workspace/workspace-pane-tree';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn(() => new Promise(() => {})) } };
});

/**
 * `react-resizable-panels`' real `PanelGroup` never fires `onLayout` under
 * jsdom (it drives real drag/measurement events this environment has no
 * layout engine for), so `useDebouncedResizeSplit`'s callback — the whole
 * reason `workspace-pane-tree.tsx` wraps `ResizablePanelGroup` at all —
 * would otherwise go untested. Mocked to plain passthrough elements that
 * capture whatever `onLayout` the tree wired up, so the test below can fire
 * it directly, the same way a real drag tick would.
 */
let capturedOnLayout: ((sizes: number[]) => void) | null = null;

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    onLayout,
  }: {
    children: React.ReactNode;
    onLayout?: (sizes: number[]) => void;
  }) => {
    capturedOnLayout = onLayout ?? null;
    return <div>{children}</div>;
  },
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

function Harness({ routeContent }: { routeContent?: React.ReactNode }): React.ReactElement {
  const workspace = useWorkspace();
  const overlay = useWorkspaceOverlay();
  const [probed, setProbed] = React.useState<string | null>(null);
  return (
    <div>
      <button onClick={() => workspace.openTab('today')}>open today</button>
      <button onClick={() => workspace.openTab('inbox', {}, { newSplit: 'horizontal' })}>
        split with inbox
      </button>
      <button onClick={() => workspace.syncRouteTab('today')}>sync route to today</button>
      <button onClick={() => setProbed(overlay.findLeafAtPoint(0, 0))}>probe leaf rect</button>
      <p data-testid="probe-result">{probed ?? 'null'}</p>
      <p data-testid="root-leaf-id">{workspace.root.kind === 'leaf' ? workspace.root.id : ''}</p>
      <p data-testid="focused-leaf-id">{workspace.focusedLeafId}</p>
      <WorkspacePaneTree node={workspace.root} routeContent={routeContent} />
    </div>
  );
}

function renderTree(routeContent?: React.ReactNode) {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <Harness routeContent={routeContent} />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockClear();
  capturedOnLayout = null;
});

describe('WorkspacePaneTree — a leaf pane', () => {
  it('shows the launcher when the pane has no active tab', () => {
    renderTree();
    // A launcher group heading is present; no tab strip (no "Open tabs" list).
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Open tabs' })).not.toBeInTheDocument();
  });

  it('shows the tab strip and the active tab’s content once a tab is open', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));

    expect(screen.getByRole('list', { name: 'Open tabs' })).toBeInTheDocument();
    // TodayTab is loading (apiClient.get never resolves) — the launcher is
    // gone and its skeleton's sr-only label is present. `role="status"`
    // doesn't compute its accessible name from content (only from
    // aria-label/aria-labelledby), so this queries the text directly.
    // "Manage" (not "Daily") is the launcher-only marker here — Today's own
    // `SectionHeader` eyebrow also reads "Daily", since Today belongs to
    // that same nav group.
    expect(screen.getByText('Loading today')).toBeInTheDocument();
    expect(screen.queryByText('Manage')).not.toBeInTheDocument();
  });
});

describe('WorkspacePaneTree — a split pane', () => {
  it('renders both children independently, each fetching its own content', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('split with inbox'));

    expect(screen.getByText('Loading today')).toBeInTheDocument();
    expect(screen.getByText('Loading inbox')).toBeInTheDocument();
  });

  it('fetches each open tab’s own endpoint independently', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('split with inbox'));

    const calledPaths = vi.mocked(apiClient.get).mock.calls.map((call) => String(call[0]));
    expect(calledPaths.some((path) => path.includes('/today'))).toBe(true);
    expect(calledPaths.some((path) => path.includes('/inbox'))).toBe(true);
  });
});

describe('WorkspacePaneTree — the route-backed tab', () => {
  it('renders routeContent instead of TabContent for the tab tagged source: route', async () => {
    const user = userEvent.setup();
    renderTree(<div>real server-rendered Today page</div>);

    await user.click(screen.getByText('sync route to today'));

    expect(screen.getByText('real server-rendered Today page')).toBeInTheDocument();
    // TabContent's own client fetch never fires for the route tab. Asserted
    // against the Today endpoint specifically rather than "nothing was
    // fetched at all" — the empty pane this tree starts on shows the
    // `Launcher`, which fetches its own inbox count.
    const calledPaths = vi.mocked(apiClient.get).mock.calls.map((call) => String(call[0]));
    expect(calledPaths).not.toContain(RESPARKABLE_API.TODAY);
  });

  it('falls back to TabContent for a launcher-opened tab even when routeContent is set', async () => {
    const user = userEvent.setup();
    renderTree(<div>real server-rendered Today page</div>);

    // "open today" opens a launcher tab (source: 'launcher'), not the route tab.
    await user.click(screen.getByText('open today'));

    expect(screen.queryByText('real server-rendered Today page')).not.toBeInTheDocument();
    expect(screen.getByText('Loading today')).toBeInTheDocument();
  });
});

describe('WorkspacePaneTree — leaf redock rect registration', () => {
  it('registers the whole pane as the redock target while the pane has no tabs (Launcher)', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('probe leaf rect'));

    // The leaf's own id is what `findLeafAtPoint` resolves to — proves the
    // registered getter ran and returned a real rect, not that the point
    // math happened to match a stale registration.
    expect(screen.getByTestId('probe-result')).toHaveTextContent(
      screen.getByTestId('root-leaf-id').textContent ?? '__missing__'
    );
  });

  it('re-registers the tab strip as the redock target once the pane has open tabs', async () => {
    const user = userEvent.setup();
    renderTree();

    const leafId = screen.getByTestId('root-leaf-id').textContent;
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('probe leaf rect'));

    expect(screen.getByTestId('probe-result')).toHaveTextContent(leafId ?? '__missing__');
  });
});

describe('WorkspacePaneTree — split resize persistence', () => {
  it('debounces a resize: the tree only persists the new sizes after the debounce window, not immediately', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('split with inbox'));

    expect(capturedOnLayout).not.toBeNull();
    capturedOnLayout?.([70, 30]);

    // Still within the 150ms debounce window — nothing persisted yet.
    const immediately = JSON.parse(window.localStorage.getItem('resparkable.workspace.v2') ?? '{}');
    expect(immediately.root?.sizes).not.toEqual([70, 30]);

    await waitFor(() => {
      const after = JSON.parse(window.localStorage.getItem('resparkable.workspace.v2') ?? '{}');
      expect(after.root?.sizes).toEqual([70, 30]);
    });
  });
});

describe('WorkspacePaneTree — which pane an interaction belongs to', () => {
  /**
   * `openTab` targets `focusedLeafId`, and nothing used to move focus except
   * the Launcher's own explicit call on its tiles. So a link or button inside
   * an *unfocused* pane opened its tab in whichever pane last had focus — the
   * thing you asked for appearing somewhere you were not looking. That is the
   * defect `WorkspaceLink` and `BoardTab`'s "All boards" were both written to
   * avoid, and neither could avoid it on its own.
   *
   * The click below deliberately lands on the Launcher's **heading**, not one
   * of its tiles: the tiles call `focusLeaf` themselves, so clicking one would
   * pass with or without the pane-level handler and prove nothing.
   */
  it('focuses a pane when it is interacted with, so a cross-open lands there', async () => {
    const user = userEvent.setup();
    renderTree();
    const originalLeafId = screen.getByTestId('root-leaf-id').textContent ?? '';
    expect(originalLeafId).not.toBe('');

    // Splitting focuses the *new* pane, leaving the original one unfocused.
    await user.click(screen.getByText('split with inbox'));
    expect(screen.getByTestId('focused-leaf-id').textContent).not.toBe(originalLeafId);

    // The original pane still has no tabs, so it shows the Launcher. Its
    // heading is inert markup inside that pane and nothing else.
    await user.click(screen.getByRole('heading', { name: 'Open a tab' }));

    expect(screen.getByTestId('focused-leaf-id').textContent).toBe(originalLeafId);
  });
});
