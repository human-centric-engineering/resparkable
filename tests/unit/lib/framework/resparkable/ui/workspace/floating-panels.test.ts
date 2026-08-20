/**
 * Unit Tests: floating-panel list operations.
 *
 * Every function here takes the list and every id it needs as arguments, so
 * there is nothing to mock — same discipline `split-tree.test.ts` follows for
 * the pane tree this state sits alongside.
 *
 * @see lib/framework/resparkable/ui/workspace/floating-panels.ts
 */

import { describe, expect, it } from 'vitest';

import {
  addFloatingPanel,
  bringFloatingPanelToFront,
  moveFloatingPanel,
  MIN_FLOATING_PANEL_HEIGHT,
  MIN_FLOATING_PANEL_WIDTH,
  nextZIndex,
  removeFloatingPanel,
  resizeFloatingPanel,
  type FloatingPanel,
} from '@/lib/framework/resparkable/ui/workspace/floating-panels';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

function panel(id: string, overrides: Partial<FloatingPanel> = {}): FloatingPanel {
  const tab: TabState = { id: `${id}-tab`, kind: 'today', params: {}, source: 'launcher' };
  return { id, tab, originLeafId: 'a', x: 0, y: 0, width: 360, height: 280, z: 1, ...overrides };
}

describe('addFloatingPanel / removeFloatingPanel', () => {
  it('appends a panel', () => {
    expect(addFloatingPanel([], panel('p1')).map((p) => p.id)).toEqual(['p1']);
  });

  it('removes a panel by id, leaving the rest untouched', () => {
    const panels = [panel('p1'), panel('p2')];
    expect(removeFloatingPanel(panels, 'p1').map((p) => p.id)).toEqual(['p2']);
  });

  it('is a no-op for an id that is not there', () => {
    const panels = [panel('p1')];
    expect(removeFloatingPanel(panels, 'missing')).toEqual(panels);
  });
});

describe('moveFloatingPanel', () => {
  it('updates only the target panel’s position', () => {
    const panels = [panel('p1', { x: 0, y: 0 }), panel('p2', { x: 5, y: 5 })];
    const next = moveFloatingPanel(panels, 'p1', 100, 200);
    expect(next.find((p) => p.id === 'p1')).toMatchObject({ x: 100, y: 200 });
    expect(next.find((p) => p.id === 'p2')).toMatchObject({ x: 5, y: 5 });
  });
});

describe('resizeFloatingPanel', () => {
  it('updates only the target panel’s size', () => {
    const panels = [panel('p1', { width: 360, height: 280 })];
    const next = resizeFloatingPanel(panels, 'p1', 500, 400);
    expect(next[0]).toMatchObject({ width: 500, height: 400 });
  });

  it('clamps below the minimum width and height', () => {
    const next = resizeFloatingPanel([panel('p1')], 'p1', 10, 10);
    expect(next[0]).toMatchObject({
      width: MIN_FLOATING_PANEL_WIDTH,
      height: MIN_FLOATING_PANEL_HEIGHT,
    });
  });
});

describe('nextZIndex / bringFloatingPanelToFront', () => {
  it('is one past the highest existing z, or 1 for an empty list', () => {
    expect(nextZIndex([])).toBe(1);
    expect(nextZIndex([panel('p1', { z: 3 }), panel('p2', { z: 1 })])).toBe(4);
  });

  it('brings the target panel above every other panel', () => {
    const panels = [panel('p1', { z: 1 }), panel('p2', { z: 2 })];
    const next = bringFloatingPanelToFront(panels, 'p1');
    const p1 = next.find((p) => p.id === 'p1')!;
    const p2 = next.find((p) => p.id === 'p2')!;
    expect(p1.z).toBeGreaterThan(p2.z);
  });

  it('is a no-op for an id that is not there', () => {
    const panels = [panel('p1', { z: 1 })];
    expect(bringFloatingPanelToFront(panels, 'missing')).toEqual(panels);
  });
});
