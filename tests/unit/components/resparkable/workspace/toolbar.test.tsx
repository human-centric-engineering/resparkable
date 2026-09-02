// @vitest-environment happy-dom

/**
 * Unit Tests: PaneToolbar.
 *
 * Rendered inside a real `WorkspaceProvider` — there's nothing to mock, so a
 * small harness reads the live tree back through `useWorkspace()` rather
 * than asserting against a mocked context.
 *
 * @see components/resparkable/workspace/toolbar.tsx
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PaneToolbar } from '@/components/resparkable/workspace/toolbar';
import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { listLeaves } from '@/lib/framework/resparkable/ui/workspace/split-tree';

/** Always targets the first leaf, left to right — stable across re-renders. */
function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  const leaves = listLeaves(workspace.root);
  return (
    <div>
      <PaneToolbar leafId={leaves[0].id} />
      <div data-testid="leaf-count">{leaves.length}</div>
    </div>
  );
}

function renderToolbar() {
  return render(
    <WorkspaceProvider>
      <Harness />
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('PaneToolbar', () => {
  it('disables Close pane when it is the only pane in the tree', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Close pane' })).toBeDisabled();
  });

  it('Split right adds a second pane', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Split right' }));

    expect(screen.getByTestId('leaf-count')).toHaveTextContent('2');
  });

  it('Split down adds a second pane', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Split down' }));

    expect(screen.getByTestId('leaf-count')).toHaveTextContent('2');
  });

  it('enables Close pane once there is more than one, and closing returns to one', async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Split right' }));
    expect(screen.getByRole('button', { name: 'Close pane' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(screen.getByTestId('leaf-count')).toHaveTextContent('1');
  });
});
