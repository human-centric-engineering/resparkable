/**
 * Floating panels — a tab that has been dragged out of its pane into its own
 * free-floating, resizable window, layered on top of `split-tree.ts`'s pane
 * tree rather than folded into it.
 *
 * A `FloatingPanel` deliberately holds no reference back into `PaneNode` — a
 * floating tab is "this `TabState` is currently not in any leaf; here's where
 * it is instead," not a new node kind mixed into the tree's recursive
 * split/close logic. That is what keeps every existing split/close/reorder
 * invariant in `split-tree.ts` (and its tests) untouched by this feature.
 *
 * Pure and owns no ids, same discipline as `split-tree.ts`: every id a
 * function needs arrives as an argument, and `workspace-context.tsx` is the
 * only impure layer allowed to call `crypto.randomUUID()`.
 *
 * Screen-bounds clamping of `x`/`y` is deliberately NOT here — it needs live
 * viewport/container dimensions, which is runtime knowledge this module has
 * no business owning. That clamping happens in `FloatingTabWindow`'s drag
 * handler instead.
 */

import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

/** A minimum a floating window can never be resized below. */
export const MIN_FLOATING_PANEL_WIDTH = 240;
export const MIN_FLOATING_PANEL_HEIGHT = 160;

export interface FloatingPanel {
  id: string;
  tab: TabState;
  /** The leaf this was dragged out of — the redock button's fallback target. */
  originLeafId: string;
  /** Local coordinates, relative to the workspace overlay's own container. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Paint order among floating panels — not a literal CSS `z-index`. */
  z: number;
}

/** One past the highest `z` among `panels`, so a new or refocused panel always paints on top. */
export function nextZIndex(panels: FloatingPanel[]): number {
  return panels.reduce((max, panel) => Math.max(max, panel.z), 0) + 1;
}

export function addFloatingPanel(panels: FloatingPanel[], panel: FloatingPanel): FloatingPanel[] {
  return [...panels, panel];
}

export function removeFloatingPanel(panels: FloatingPanel[], panelId: string): FloatingPanel[] {
  return panels.filter((panel) => panel.id !== panelId);
}

export function moveFloatingPanel(
  panels: FloatingPanel[],
  panelId: string,
  x: number,
  y: number
): FloatingPanel[] {
  return panels.map((panel) => (panel.id === panelId ? { ...panel, x, y } : panel));
}

export function resizeFloatingPanel(
  panels: FloatingPanel[],
  panelId: string,
  width: number,
  height: number
): FloatingPanel[] {
  return panels.map((panel) =>
    panel.id === panelId
      ? {
          ...panel,
          width: Math.max(width, MIN_FLOATING_PANEL_WIDTH),
          height: Math.max(height, MIN_FLOATING_PANEL_HEIGHT),
        }
      : panel
  );
}

/**
 * Applies `update` to whichever panel holds the tab `tabId`, keyed on the
 * **tab's** id rather than the panel's.
 *
 * The mirror of `split-tree.ts`'s `updateTab`, and keyed the same way for the
 * same reason: a tab content adapter knows its own tab id and has no idea
 * whether it is currently docked in a pane or floating in a window. One
 * `setTabParams(tabId, …)` on the context can therefore hit either, without
 * the caller branching on where the tab lives.
 */
export function updateFloatingPanelTab(
  panels: FloatingPanel[],
  tabId: string,
  update: (tab: FloatingPanel['tab']) => FloatingPanel['tab']
): FloatingPanel[] {
  let changed = false;
  const next = panels.map((panel) => {
    if (panel.tab.id !== tabId) return panel;
    const tab = update(panel.tab);
    if (tab === panel.tab) return panel;
    changed = true;
    return { ...panel, tab };
  });
  // The identity of the input array, not a fresh copy of it, when nothing
  // moved — `workspace-context.tsx` compares identities to decide whether a
  // write is a no-op, and a `map` that always allocates would defeat that.
  return changed ? next : panels;
}

/** Brings `panelId` to the front of the paint order. No-op if it isn't there. */
export function bringFloatingPanelToFront(
  panels: FloatingPanel[],
  panelId: string
): FloatingPanel[] {
  if (!panels.some((panel) => panel.id === panelId)) return panels;
  const z = nextZIndex(panels);
  return panels.map((panel) => (panel.id === panelId ? { ...panel, z } : panel));
}
