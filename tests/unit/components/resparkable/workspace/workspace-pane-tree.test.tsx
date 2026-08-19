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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspacePaneTree } from '@/components/resparkable/workspace/workspace-pane-tree';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn(() => new Promise(() => {})) } };
});

function Harness({ routeContent }: { routeContent?: React.ReactNode }): React.ReactElement {
  const workspace = useWorkspace();
  return (
    <div>
      <button onClick={() => workspace.openTab('today')}>open today</button>
      <button onClick={() => workspace.openTab('inbox', {}, { newSplit: 'horizontal' })}>
        split with inbox
      </button>
      <button onClick={() => workspace.syncRouteTab('today')}>sync route to today</button>
      <WorkspacePaneTree node={workspace.root} routeContent={routeContent} />
    </div>
  );
}

function renderTree(routeContent?: React.ReactNode) {
  return render(
    <WorkspaceProvider>
      <Harness routeContent={routeContent} />
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(apiClient.get).mockClear();
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
    // TabContent's own client fetch never fires for the route tab.
    expect(apiClient.get).not.toHaveBeenCalled();
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
