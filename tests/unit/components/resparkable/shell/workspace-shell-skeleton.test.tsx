// @vitest-environment happy-dom

/**
 * Unit Tests: WorkspaceShellSkeleton.
 *
 * What matters: it announces one loading state to assistive tech (not a
 * pile of unlabeled shapes), and it actually renders placeholders for all
 * three segments arriving — Sparkey, the Workspace tab tree, and Activity —
 * not just a spinner.
 *
 * @see components/resparkable/shell/workspace-shell-skeleton.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WorkspaceShellSkeleton } from '@/components/resparkable/shell/workspace-shell-skeleton';

describe('WorkspaceShellSkeleton', () => {
  it('announces one loading status for assistive tech', () => {
    render(<WorkspaceShellSkeleton />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Loading your workspace')).toBeInTheDocument();
  });

  it('renders placeholder content for all three panes, not just a spinner', () => {
    const { container } = render(<WorkspaceShellSkeleton />);

    // Three pane columns, each with its own header row and body content —
    // a bare centred spinner would fail this by construction.
    const placeholders = container.querySelectorAll('[aria-hidden="true"]');
    expect(placeholders.length).toBeGreaterThan(10);
  });
});
