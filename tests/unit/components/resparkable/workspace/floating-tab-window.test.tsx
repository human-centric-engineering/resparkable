/**
 * Unit Tests: FloatingTabWindow.
 *
 * Covers everything reachable without simulating a real pointer *drag*:
 * rendering, the redock and close buttons, and that a plain click on either
 * doesn't also start a drag via bubbling into the title bar's own
 * `onPointerDown` (the reason both controls stop propagation). Drag-to-move
 * and drag-to-resize are left to manual/e2e coverage — `setPointerCapture`
 * isn't implemented in jsdom, and `TabStrip`'s own header comment already
 * notes the same limitation for dnd-kit's pointer sensor.
 *
 * @see components/resparkable/workspace/floating-tab-window.tsx
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { FloatingTabWindow } from '@/components/resparkable/workspace/floating-tab-window';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

const ROOT_LEAF_ID = 'root';

/** Opens an Inbox tab in the root leaf, then can detach it into a floating panel. */
function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;
  const panel = workspace.floatingPanels[0];

  return (
    <div>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <button
        onClick={() =>
          leaf.tabs[0] && workspace.detachTab(ROOT_LEAF_ID, leaf.tabs[0].id, { x: 10, y: 20 })
        }
      >
        detach
      </button>
      <div data-testid="panel-count">{workspace.floatingPanels.length}</div>
      <div data-testid="leaf-tab-count">{leaf.tabs.length}</div>
      {panel && <FloatingTabWindow panel={panel} />}
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

async function openAndDetach(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText('open inbox'));
  await user.click(screen.getByText('detach'));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('FloatingTabWindow', () => {
  it('renders the detached tab’s title as an accessible dialog name', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    expect(screen.getByRole('dialog', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('close discards the panel without redocking the tab', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    await user.click(screen.getByRole('button', { name: 'Close Inbox' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');
  });

  it('the redock button docks the tab back into its origin leaf', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    await user.click(screen.getByRole('button', { name: 'Dock this tab' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('1');
  });

  it('a pointerdown on the window does not throw (setPointerCapture is unguarded nowhere)', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    const dialog = screen.getByRole('dialog', { name: 'Inbox' });
    expect(() => fireEvent.pointerDown(dialog)).not.toThrow();
  });
});
