/**
 * Unit Tests: WorkspaceShell.
 *
 * This is the orchestration layer — `SparkeyPane`, `ActivityPane`,
 * `PresentPane`, `ResparkableAppHeader`, `ProtectedFooter`,
 * `RouteTabBridge`, `MobilePaneSwitcher`, `WorkspacePanesSkeleton` and
 * `FloatingPanelsLayer` all have their own dedicated test files (see
 * `tests/unit/components/resparkable/shell/` and `.../workspace/`), so
 * every one of them is mocked to a marker here. What's actually under
 * test is `WorkspaceShell`'s own wiring: which layout it picks for a
 * given `isDesktop` result, how a click on `PaneCollapseButton` or on a
 * pane's own "expand" affordance turns into the *specific* imperative
 * panel call the header comment promises (`.collapse()` to shrink,
 * `.resize(22)` — the fixed `SIDE_PANE_DEFAULT_SIZE` — to reopen, never
 * `.expand()`, which would replay whatever size a manual drag left the
 * panel at), and how the Present button wires into the dialog.
 *
 * `@/components/ui/resizable` is mocked too, for a mechanical reason: a
 * quick probe (`ResizablePanel.collapse()`/`.resize()` called on a real
 * `react-resizable-panels` panel, in this suite's happy-dom environment)
 * never fires `onCollapse`/`onExpand` — the library's real collapse
 * threshold depends on measured layout happy-dom doesn't produce. The fake
 * below reproduces just the imperative contract `WorkspaceShell` relies on
 * (`collapse()` → `onCollapse`, `resize(size)` → `onExpand` unless `size`
 * equals `collapsedSize`) and records the exact method + argument each
 * `ResizablePanel` instance last received, in render order (Sparkey,
 * middle, Activity), so a test can assert `resize(22)` specifically
 * happened rather than merely that *some* expand-shaped call did.
 *
 * @see components/resparkable/shell/workspace-shell.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { WorkspaceShell } from '@/components/resparkable/shell/workspace-shell';

const mockUseMediaQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: (query: string, initialValue?: boolean) => mockUseMediaQuery(query, initialValue),
}));

vi.mock('@/components/resparkable/shell/app-header', () => ({
  ResparkableAppHeader: ({ onPresent }: { onPresent?: () => void }) => (
    <header>
      <span>app header marker</span>
      {onPresent && <button onClick={onPresent}>Present trigger</button>}
    </header>
  ),
}));

vi.mock('@/components/layouts/protected-footer', () => ({
  ProtectedFooter: () => <footer>footer marker</footer>,
}));

vi.mock('@/components/resparkable/sparkey/sparkey-pane', () => ({
  SparkeyPane: ({ collapsed, onExpand }: { collapsed?: boolean; onExpand?: () => void }) => (
    <div>
      <p>sparkey pane marker (collapsed: {String(Boolean(collapsed))})</p>
      <button onClick={onExpand}>expand sparkey from pane</button>
    </div>
  ),
}));

vi.mock('@/components/resparkable/activity/activity-pane', () => ({
  ActivityPane: ({ collapsed, onExpand }: { collapsed?: boolean; onExpand?: () => void }) => (
    <div>
      <p>activity pane marker (collapsed: {String(Boolean(collapsed))})</p>
      <button onClick={onExpand}>expand activity from pane</button>
    </div>
  ),
}));

vi.mock('@/components/resparkable/workspace/present/present-pane', () => ({
  PresentPane: ({ payload }: { payload: unknown }) => (
    <p>present pane marker (payload: {String(payload)})</p>
  ),
}));

vi.mock('@/components/resparkable/shell/workspace-shell-skeleton', () => ({
  WorkspacePanesSkeleton: () => <div>skeleton marker</div>,
}));

vi.mock('@/components/resparkable/workspace/floating-panels-layer', () => ({
  FloatingPanelsLayer: () => <div>floating panels layer marker</div>,
}));

vi.mock('@/components/resparkable/shell/route-tab-bridge', () => ({
  RouteTabBridge: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="route-tab-bridge">{children}</div>
  ),
}));

vi.mock('@/components/resparkable/shell/mobile-pane-switcher', () => ({
  MobilePaneSwitcher: ({ workspaceContent }: { workspaceContent: React.ReactNode }) => (
    <div data-testid="mobile-pane-switcher">{workspaceContent}</div>
  ),
}));

vi.mock('@/components/ui/resizable', () => {
  const ResizablePanelGroup = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );

  interface FakePanelProps {
    children?: React.ReactNode;
    collapsedSize?: number;
    onCollapse?: () => void;
    onExpand?: () => void;
  }

  // Records the exact imperative call this panel instance last received —
  // read via `getAllByTestId('panel-last-call')`, which returns the three
  // panels in render order (Sparkey, middle, Activity).
  const ResizablePanel = React.forwardRef<ImperativePanelHandle, FakePanelProps>(
    function FakeResizablePanel({ children, collapsedSize, onCollapse, onExpand }, ref) {
      const [lastCall, setLastCall] = React.useState('none');

      React.useImperativeHandle(ref, () => ({
        collapse: () => {
          setLastCall('collapse()');
          onCollapse?.();
        },
        expand: (minSize?: number) => {
          setLastCall(`expand(${minSize ?? ''})`);
          onExpand?.();
        },
        resize: (size: number) => {
          setLastCall(`resize(${size})`);
          if (collapsedSize !== undefined && size === collapsedSize) {
            onCollapse?.();
          } else {
            onExpand?.();
          }
        },
        getId: () => 'fake-panel',
        getSize: () => 0,
        isCollapsed: () => false,
        isExpanded: () => true,
      }));

      return (
        <div>
          <span data-testid="panel-last-call" data-panel-call={lastCall} />
          {children}
        </div>
      );
    }
  );

  const ResizableHandle = ({ children }: { children?: React.ReactNode }) => (
    <div role="separator">{children}</div>
  );

  return { ResizablePanelGroup, ResizablePanel, ResizableHandle };
});

function renderShell(children: React.ReactNode = <div>page content marker</div>) {
  return render(<WorkspaceShell>{children}</WorkspaceShell>);
}

/** `panel-last-call` markers in render order: Sparkey, middle, Activity. */
function panelCalls(): Array<string | null> {
  return screen.getAllByTestId('panel-last-call').map((el) => el.getAttribute('data-panel-call'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMediaQuery.mockReturnValue(true);
  window.localStorage.clear();
});

describe('layout selection', () => {
  it('queries the desktop breakpoint with a desktop-biased initial guess', () => {
    renderShell();

    expect(mockUseMediaQuery).toHaveBeenCalledWith('(min-width: 1024px)', true);
  });

  it('renders the tiled three-pane desktop layout when isDesktop is true', () => {
    mockUseMediaQuery.mockReturnValue(true);
    renderShell();

    expect(screen.getByText(/sparkey pane marker/)).toBeInTheDocument();
    expect(screen.getByText(/activity pane marker/)).toBeInTheDocument();
    expect(screen.getByText('floating panels layer marker')).toBeInTheDocument();
    expect(screen.getByTestId('route-tab-bridge')).toBeInTheDocument();
    expect(screen.getByText('page content marker')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-pane-switcher')).not.toBeInTheDocument();
  });

  it('renders MobilePaneSwitcher instead of the tiled panes when isDesktop is false', () => {
    mockUseMediaQuery.mockReturnValue(false);
    renderShell();

    const switcher = screen.getByTestId('mobile-pane-switcher');
    // The same RouteTabBridge-wrapped children the desktop branch would
    // give the middle pane are handed to MobilePaneSwitcher's
    // `workspaceContent` prop, not dropped.
    expect(within(switcher).getByTestId('route-tab-bridge')).toBeInTheDocument();
    expect(within(switcher).getByText('page content marker')).toBeInTheDocument();

    // None of the desktop-only tiling exists in this branch.
    expect(screen.queryByText('floating panels layer marker')).not.toBeInTheDocument();
    expect(screen.queryByText(/sparkey pane marker/)).not.toBeInTheDocument();
    expect(screen.queryByText(/activity pane marker/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse Sparkey' })).not.toBeInTheDocument();
  });

  it('always renders the header and footer regardless of layout', () => {
    mockUseMediaQuery.mockReturnValue(false);
    renderShell();

    expect(screen.getByText('app header marker')).toBeInTheDocument();
    expect(screen.getByText('footer marker')).toBeInTheDocument();
  });
});

describe('Sparkey collapse/expand', () => {
  it('starts expanded', () => {
    renderShell();

    expect(screen.getByText('sparkey pane marker (collapsed: false)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Sparkey' })).toBeInTheDocument();
  });

  it('collapses Sparkey via its PaneCollapseButton, by calling the panel’s .collapse()', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse Sparkey' }));

    expect(screen.getByText('sparkey pane marker (collapsed: true)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Sparkey' })).toBeInTheDocument();
    expect(panelCalls()[0]).toBe('collapse()');
  });

  it('re-expands Sparkey via the same button, resizing to the fixed default rather than calling .expand()', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse Sparkey' }));
    await user.click(screen.getByRole('button', { name: 'Show Sparkey' }));

    expect(screen.getByText('sparkey pane marker (collapsed: false)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Sparkey' })).toBeInTheDocument();
    // Specifically resize(22) — SIDE_PANE_DEFAULT_SIZE — not expand(), so a
    // re-open always lands at the same predictable width regardless of
    // whatever size a prior manual drag left the panel at.
    expect(panelCalls()[0]).toBe('resize(22)');
  });

  it('lets SparkeyPane expand itself via its own onExpand affordance (the collapsed rail)', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse Sparkey' }));
    await user.click(screen.getByRole('button', { name: 'expand sparkey from pane' }));

    expect(screen.getByText('sparkey pane marker (collapsed: false)')).toBeInTheDocument();
    expect(panelCalls()[0]).toBe('resize(22)');
  });
});

describe('Activity collapse/expand', () => {
  it('collapses and re-expands independently of Sparkey', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse Activity' }));

    expect(screen.getByText('activity pane marker (collapsed: true)')).toBeInTheDocument();
    expect(screen.getByText('sparkey pane marker (collapsed: false)')).toBeInTheDocument();
    const [sparkeyCall, , activityCall] = panelCalls();
    expect(activityCall).toBe('collapse()');
    expect(sparkeyCall).toBe('none');

    await user.click(screen.getByRole('button', { name: 'Show Activity' }));

    expect(screen.getByText('activity pane marker (collapsed: false)')).toBeInTheDocument();
    expect(panelCalls()[2]).toBe('resize(22)');
  });

  it('lets ActivityPane expand itself via its own onExpand affordance', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse Activity' }));
    await user.click(screen.getByRole('button', { name: 'expand activity from pane' }));

    expect(screen.getByText('activity pane marker (collapsed: false)')).toBeInTheDocument();
    expect(panelCalls()[2]).toBe('resize(22)');
  });
});

describe('Present mode', () => {
  it('does not render the Present dialog until requested', () => {
    renderShell();

    expect(screen.queryByText(/present pane marker/)).not.toBeInTheDocument();
  });

  it('opens the Present dialog with a null payload when the header requests it', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Present trigger' }));

    expect(screen.getByRole('heading', { name: 'Present' })).toBeInTheDocument();
    expect(screen.getByText('present pane marker (payload: null)')).toBeInTheDocument();
  });

  it('closes the Present dialog via its own close control, unmounting PresentPane', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Present trigger' }));
    expect(screen.getByText(/present pane marker/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByText(/present pane marker/)).not.toBeInTheDocument();
  });
});
