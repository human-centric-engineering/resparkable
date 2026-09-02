// @vitest-environment happy-dom

/**
 * Unit Tests: FloatingPanelsLayer.
 *
 * `FloatingPanelsLayer` itself does one thing: read `useWorkspace().floatingPanels`
 * and render one `FloatingTabWindow` per entry. `FloatingTabWindow`'s own
 * rendering/interaction behaviour (redock, close, dialog naming) is already
 * covered by `floating-tab-window.test.tsx` — these tests stay scoped to what
 * this file actually controls: the empty case, rendering N panels for N
 * detached tabs, keeping the list in sync as panels are added/removed, and
 * not swallowing whatever else the shell renders alongside it.
 *
 * @see components/resparkable/workspace/floating-panels-layer.tsx
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { FloatingPanelsLayer } from '@/components/resparkable/workspace/floating-panels-layer';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';
import type { TabKind } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

const ROOT_LEAF_ID = 'root';

/** Opens tabs in the root leaf and can detach any of them into floating panels. */
function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;

  function detach(kind: TabKind): void {
    const tab = leaf.tabs.find((candidate) => candidate.kind === kind);
    if (tab) workspace.detachTab(ROOT_LEAF_ID, tab.id, { x: 0, y: 0 });
  }

  return (
    <div>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <button onClick={() => workspace.openTab('projects')}>open projects</button>
      <button onClick={() => detach('inbox')}>detach inbox</button>
      <button onClick={() => detach('projects')}>detach projects</button>
      <button
        onClick={() =>
          workspace.floatingPanels[0] &&
          workspace.closeFloatingPanel(workspace.floatingPanels[0].id)
        }
      >
        close first panel
      </button>
      <div data-testid="panel-count">{workspace.floatingPanels.length}</div>
      <FloatingPanelsLayer />
    </div>
  );
}

function renderHarness() {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <Harness />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('FloatingPanelsLayer', () => {
  it('renders no floating windows when there are no detached tabs', () => {
    renderHarness();

    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });

  it('renders one floating window per detached tab', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('detach inbox'));

    expect(screen.getByRole('dialog', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('renders a separate window for each of several detached tabs', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('open projects'));
    await user.click(screen.getByText('detach inbox'));
    await user.click(screen.getByText('detach projects'));

    expect(screen.getByRole('dialog', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
  });

  it('removes a window from the DOM once its panel is closed', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('detach inbox'));
    expect(screen.getByRole('dialog', { name: 'Inbox' })).toBeInTheDocument();

    await user.click(screen.getByText('close first panel'));

    expect(screen.queryByRole('dialog', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
  });

  it('keeps rendering the windows for the panels that remain after one closes', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('open projects'));
    await user.click(screen.getByText('detach inbox'));
    await user.click(screen.getByText('detach projects'));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    // `floatingPanels[0]` is the Inbox panel — detached first, so it sorts first.
    await user.click(screen.getByText('close first panel'));

    expect(screen.queryByRole('dialog', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
