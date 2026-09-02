// @vitest-environment happy-dom

/**
 * Unit Tests: NodeSelector.
 *
 * Covers the checklist that stands in for a real Graph canvas selection
 * (see `build-slides.ts`'s header comment for why there's no canvas
 * gesture yet): checking a node reports its `"type:id"` key, the count on
 * "Build deck" tracks the selection, and the button is disabled with
 * nothing checked so an empty deck can't be built by mistake.
 *
 * @see components/resparkable/workspace/present/node-selector.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodeSelector } from '@/components/resparkable/workspace/present/node-selector';
import type { GraphNodeWire } from '@/lib/framework/resparkable/ui/payloads';

const NODES: GraphNodeWire[] = [
  { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: 'The big push', depth: 0 },
  { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, depth: 1 },
];

describe('NodeSelector', () => {
  it('lists every node, with its subtitle when it has one', () => {
    render(
      <NodeSelector nodes={NODES} selectedKeys={new Set()} onToggle={vi.fn()} onBuild={vi.fn()} />
    );

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('The big push')).toBeInTheDocument();
    expect(screen.getByText('A note')).toBeInTheDocument();
  });

  it('reports the toggled node’s key', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <NodeSelector nodes={NODES} selectedKeys={new Set()} onToggle={onToggle} onBuild={vi.fn()} />
    );

    await user.click(screen.getByLabelText(/Q4 launch/));

    expect(onToggle).toHaveBeenCalledWith('project:proj_1');
  });

  it('checks the box for an already-selected node', () => {
    render(
      <NodeSelector
        nodes={NODES}
        selectedKeys={new Set(['project:proj_1'])}
        onToggle={vi.fn()}
        onBuild={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/Q4 launch/)).toBeChecked();
    expect(screen.getByLabelText('A note')).not.toBeChecked();
  });

  it('disables "Build deck" with nothing selected, and shows the count once something is', () => {
    const { rerender } = render(
      <NodeSelector nodes={NODES} selectedKeys={new Set()} onToggle={vi.fn()} onBuild={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Build deck (0)' })).toBeDisabled();

    rerender(
      <NodeSelector
        nodes={NODES}
        selectedKeys={new Set(['project:proj_1'])}
        onToggle={vi.fn()}
        onBuild={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Build deck (1)' })).toBeEnabled();
  });

  it('calls onBuild when clicked', async () => {
    const user = userEvent.setup();
    const onBuild = vi.fn();
    render(
      <NodeSelector
        nodes={NODES}
        selectedKeys={new Set(['project:proj_1'])}
        onToggle={vi.fn()}
        onBuild={onBuild}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Build deck (1)' }));

    expect(onBuild).toHaveBeenCalledTimes(1);
  });
});
