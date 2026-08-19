/**
 * Unit Tests: WorkspacePaneTree.
 *
 * Covers the render-time decision this file exists to make: a leaf shows
 * the launcher or its active tab depending on `activeTabId`, and a split
 * recurses into a nested `ResizablePanelGroup` per child, one level for
 * each level of nesting. The placeholder tab content is intentionally
 * checked against its exact "Phase 3" wording, so this test starts failing
 * the moment a Phase 3 adapter actually replaces it — which is the signal
 * to update or delete it, not evidence of a regression.
 *
 * @see components/resparkable/workspace/workspace-pane-tree.tsx
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspacePaneTree } from '@/components/resparkable/workspace/workspace-pane-tree';

function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  return (
    <div>
      <button onClick={() => workspace.openTab('today')}>open today</button>
      <button onClick={() => workspace.openTab('inbox', {}, { newSplit: 'horizontal' })}>
        split with inbox
      </button>
      <WorkspacePaneTree node={workspace.root} />
    </div>
  );
}

function renderTree() {
  return render(
    <WorkspaceProvider>
      <Harness />
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('WorkspacePaneTree — a leaf pane', () => {
  it('shows the launcher when the pane has no active tab', () => {
    renderTree();
    // A launcher group heading is present; no tab strip (no "Open tabs" list).
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Open tabs' })).not.toBeInTheDocument();
  });

  it('shows the tab strip and the active tab’s placeholder once a tab is open', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));

    expect(screen.getByRole('list', { name: 'Open tabs' })).toBeInTheDocument();
    expect(screen.getByText(/Today — content adapter arrives in Phase 3\./)).toBeInTheDocument();
    expect(screen.queryByText('Daily')).not.toBeInTheDocument();
  });
});

describe('WorkspacePaneTree — a split pane', () => {
  it('renders both children independently, each with its own content', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('split with inbox'));

    expect(screen.getByText(/Today — content adapter arrives in Phase 3\./)).toBeInTheDocument();
    expect(screen.getByText(/Inbox — content adapter arrives in Phase 3\./)).toBeInTheDocument();
  });
});
