// @vitest-environment happy-dom

/**
 * Unit Tests: PaneRail.
 *
 * The collapsed-drawer strip `SparkeyPane`/`ActivityPane` render in place
 * of their real content. What matters: it's one clickable region (not just
 * a small icon inside it), it's named for screen readers, and the visible
 * label reads as the pane's name.
 *
 * @see components/resparkable/shell/pane-rail.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Waves } from 'lucide-react';

import { PaneRail } from '@/components/resparkable/shell/pane-rail';

describe('PaneRail', () => {
  it('renders one clickable strip, named for the pane it re-opens', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<PaneRail label="Sparkey" side="left" icon={Waves} onExpand={onExpand} />);

    const rail = screen.getByRole('button', { name: 'Show Sparkey' });
    expect(rail).toBeInTheDocument();
    expect(rail).toHaveTextContent('Sparkey');

    await user.click(rail);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('is a single element — clicking anywhere in it (not just an inner icon) re-opens', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<PaneRail label="Activity" side="right" icon={Waves} onExpand={onExpand} />);

    // The whole strip is the <button> itself, so there is exactly one
    // button in the tree, not a wrapper plus a separate icon target.
    expect(screen.getAllByRole('button')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Show Activity' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
