/**
 * Unit Tests: TabStrip.
 *
 * Covers everything reachable without simulating a pointer drag: rendering,
 * click-to-activate, close, and the "+" launcher affordance. Reordering
 * itself is `reorderTab`'s pure-tree guarantee, already table-tested in
 * `split-tree.test.ts` — `onDragEnd` here is a four-line pass-through to it,
 * and dnd-kit's pointer-sensor gesture is not something jsdom can drive
 * reliably, so the drag *gesture* is left to manual/e2e coverage rather than
 * faked into a brittle unit test.
 *
 * @see components/resparkable/workspace/tab-strip.tsx
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { TabStrip } from '@/components/resparkable/workspace/tab-strip';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

const ROOT_LEAF_ID = 'root';

/** Opens two distinct tabs in the root leaf before rendering the strip against it. */
function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;

  return (
    <div>
      <button onClick={() => workspace.openTab('today')}>open today</button>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <TabStrip leafId={ROOT_LEAF_ID} tabs={leaf.tabs} activeTabId={leaf.activeTabId} />
      <div data-testid="active-tab-id">{leaf.activeTabId ?? 'null'}</div>
      <div data-testid="tab-count">{leaf.tabs.length}</div>
    </div>
  );
}

function renderStrip() {
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

describe('TabStrip', () => {
  it('renders each open tab by its default title', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));

    const strip = screen.getByRole('list', { name: 'Open tabs' });
    expect(within(strip).getByText('Today')).toBeInTheDocument();
    expect(within(strip).getByText('Inbox')).toBeInTheDocument();
  });

  it('renders the tab kind’s icon to the left of the label', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));

    const pill = screen.getByText('Today').closest('[role="button"]') as HTMLElement;
    const icon = pill.querySelector('svg');
    const label = screen.getByText('Today');
    expect(icon).toBeInTheDocument();
    // DOM order, not just presence — the icon precedes the label text node.
    expect(icon!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('activates a tab on click', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox')); // inbox is now active

    await user.click(screen.getByText('Today'));

    expect(screen.getByTestId('active-tab-id')).not.toHaveTextContent('null');
    // Today's pill carries aria-current once it's the active tab again.
    expect(screen.getByText('Today').closest('[role="button"]')).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('activates a tab via keyboard (Enter)', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));

    const todayPill = screen.getByText('Today').closest('[role="button"]') as HTMLElement;
    todayPill.focus();
    await user.keyboard('{Enter}');

    expect(todayPill).toHaveAttribute('aria-current', 'true');
  });

  it('closes a tab without activating a different one first', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    expect(screen.getByTestId('tab-count')).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'Close Today' }));

    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });

  it('the "+" button shows the launcher without closing any open tab', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByRole('button', { name: 'Open something new' }));

    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('null');
    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
  });
});
