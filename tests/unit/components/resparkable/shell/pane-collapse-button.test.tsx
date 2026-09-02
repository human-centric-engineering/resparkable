// @vitest-environment happy-dom

/**
 * Unit Tests: PaneCollapseButton.
 *
 * The floating toggle `WorkspaceShell` mounts inside each side handle's
 * `children` slot — one button covers both directions, so what matters is
 * that its accessible name and chevron direction track `collapsed`
 * correctly per `side`, and that `onToggle` fires on click.
 *
 * @see components/resparkable/shell/pane-collapse-button.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PaneCollapseButton } from '@/components/resparkable/shell/pane-collapse-button';

describe('PaneCollapseButton', () => {
  it('labels a left-side, expanded pane as collapsible and fires onToggle', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <PaneCollapseButton side="left" collapsed={false} onToggle={onToggle} label="Sparkey" />
    );

    const button = screen.getByRole('button', { name: 'Collapse Sparkey' });
    await user.click(button);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('labels a left-side, collapsed pane as expandable', () => {
    render(<PaneCollapseButton side="left" collapsed onToggle={vi.fn()} label="Sparkey" />);

    expect(screen.getByRole('button', { name: 'Show Sparkey' })).toBeInTheDocument();
  });

  it('labels a right-side pane the same way, independent of side', () => {
    const { rerender } = render(
      <PaneCollapseButton side="right" collapsed={false} onToggle={vi.fn()} label="Activity" />
    );
    expect(screen.getByRole('button', { name: 'Collapse Activity' })).toBeInTheDocument();

    rerender(<PaneCollapseButton side="right" collapsed onToggle={vi.fn()} label="Activity" />);
    expect(screen.getByRole('button', { name: 'Show Activity' })).toBeInTheDocument();
  });
});
