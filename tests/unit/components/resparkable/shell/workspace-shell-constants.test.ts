import { describe, it, expect } from 'vitest';
import { SIDE_PANE_DEFAULT_SIZE } from '@/components/resparkable/shell/workspace-shell-constants';

describe('components/resparkable/shell/workspace-shell-constants', () => {
  it('exports the side panels default size as a number between 0 and 100', () => {
    expect(typeof SIDE_PANE_DEFAULT_SIZE).toBe('number');
    expect(SIDE_PANE_DEFAULT_SIZE).toBeGreaterThan(0);
    expect(SIDE_PANE_DEFAULT_SIZE).toBeLessThan(50);
  });

  it('leaves room for the center pane when two side panels use it', () => {
    // Two side panels at this size must not consume the whole width — the
    // center pane needs a positive share, the invariant workspace-shell.tsx
    // and workspace-shell-skeleton.tsx both build their layout math on.
    expect(SIDE_PANE_DEFAULT_SIZE * 2).toBeLessThan(100);
  });
});
