/**
 * Unit Tests: FloatingTabWindow.
 *
 * Covers rendering, the redock and close buttons, the redock button's
 * fallback to the focused leaf once its origin leaf is gone, and both
 * hand-rolled pointer-event gestures (title-bar drag-to-move, corner
 * handle drag-to-resize) end to end — including the pointer-id and
 * "no active drag" guards each handler opens with, and the drop-target
 * hit test that decides whether a drag-release re-docks the tab.
 *
 * happy-dom (this suite's `environment`, see `vitest.config.ts`) implements
 * `PointerEvent` with `pointerId`/`clientX`/`clientY` and no-op
 * `setPointerCapture`/`releasePointerCapture` methods that never throw, so a
 * full pointerdown → pointermove → pointerup sequence can be simulated with
 * plain `fireEvent` calls — no library or manual event dispatch needed.
 *
 * @see components/resparkable/workspace/floating-tab-window.tsx
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
} from '@/components/resparkable/workspace/workspace-overlay-context';
import { FloatingTabWindow } from '@/components/resparkable/workspace/floating-tab-window';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

const ROOT_LEAF_ID = 'root';

/** A detached panel's default starting size — `DEFAULT_FLOATING_WIDTH`/`HEIGHT` in `workspace-context.tsx`. */
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 280;

/**
 * Registers a fixed drop-target rect for `leafId` against the workspace
 * overlay, the same registry `WorkspacePane` populates in the real shell.
 * Not rendered in every harness — only the tests that need a drag to
 * actually land on something mount it.
 */
function DropTarget({
  leafId,
  left,
  right,
  top,
  bottom,
}: {
  leafId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}): null {
  const overlay = useWorkspaceOverlay();
  React.useEffect(
    () => overlay.registerLeafRect(leafId, () => ({ left, right, top, bottom }) as DOMRect),
    [overlay, leafId, left, right, top, bottom]
  );
  return null;
}

/** Opens an Inbox tab in the root leaf, then can detach it into a floating panel. */
function Harness({ dropTarget }: { dropTarget?: boolean }): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;
  const panel = workspace.floatingPanels[0];

  return (
    <div>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <button
        onClick={() =>
          leaf.tabs[0] && workspace.detachTab(ROOT_LEAF_ID, leaf.tabs[0].id, { x: 10, y: 20 })
        }
      >
        detach
      </button>
      <div data-testid="panel-count">{workspace.floatingPanels.length}</div>
      <div data-testid="leaf-tab-count">{leaf.tabs.length}</div>
      <div data-testid="panel-x">{panel?.x}</div>
      <div data-testid="panel-y">{panel?.y}</div>
      <div data-testid="panel-width">{panel?.width}</div>
      <div data-testid="panel-height">{panel?.height}</div>
      {/* The rect (200,150)-(300,250) is chosen to contain the drag tests'
          computed drop-point centre below (240, 190) — see the docking test. */}
      {dropTarget && (
        <DropTarget leafId={ROOT_LEAF_ID} left={200} right={300} top={150} bottom={250} />
      )}
      {panel && <FloatingTabWindow panel={panel} />}
    </div>
  );
}

function renderHarness(opts?: { dropTarget?: boolean }) {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <Harness dropTarget={opts?.dropTarget} />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

async function openAndDetach(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText('open inbox'));
  await user.click(screen.getByText('detach'));
}

/** Harness for the redock button's fallback path: split off a second leaf, detach from root, then close root. */
function RedockFallbackHarness(): React.ReactElement {
  const workspace = useWorkspace();
  const rootLeaf = findLeaf(workspace.root, ROOT_LEAF_ID);
  const panel = workspace.floatingPanels[0];
  const focusedLeaf = findLeaf(workspace.root, workspace.focusedLeafId);

  return (
    <div>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <button onClick={() => workspace.splitLeaf(ROOT_LEAF_ID, 'horizontal')}>split</button>
      <button
        onClick={() => {
          const tab = rootLeaf?.tabs[0];
          if (tab) workspace.detachTab(ROOT_LEAF_ID, tab.id, { x: 10, y: 20 });
        }}
      >
        detach from root
      </button>
      <button onClick={() => workspace.closeLeaf(ROOT_LEAF_ID)}>close root leaf</button>
      <div data-testid="focused-leaf-tab-count">{focusedLeaf?.tabs.length ?? 0}</div>
      <div data-testid="panel-count">{workspace.floatingPanels.length}</div>
      {panel && <FloatingTabWindow panel={panel} />}
    </div>
  );
}

function renderRedockFallbackHarness() {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <RedockFallbackHarness />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The dialog's own rendered position/size — what `liveRect` drives mid-gesture,
 * ahead of the debounced persisted write `panel-x`/`-y`/`-width`/`-height`
 * (`workspace.floatingPanels[0]`) only reflects once that write lands.
 */
function liveStyle(): { left: string; top: string; width: string; height: string } {
  const { style } = screen.getByRole('dialog', { name: 'Inbox' });
  return { left: style.left, top: style.top, width: style.width, height: style.height };
}

describe('FloatingTabWindow', () => {
  it('renders the detached tab’s title as an accessible dialog name', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    expect(screen.getByRole('dialog', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('close discards the panel without redocking the tab', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    await user.click(screen.getByRole('button', { name: 'Close Inbox' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');
  });

  it('the redock button docks the tab back into its origin leaf', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    await user.click(screen.getByRole('button', { name: 'Dock this tab' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
    expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('1');
  });

  it('the redock button falls back to the focused leaf once the origin leaf is gone', async () => {
    const user = userEvent.setup();
    renderRedockFallbackHarness();

    // Root gets the tab, then a sibling leaf is split off and focused.
    await user.click(screen.getByText('open inbox'));
    await user.click(screen.getByText('split'));
    // Pull the tab out of root into a floating panel (originLeafId = root).
    await user.click(screen.getByText('detach from root'));
    // Root is now an empty leaf; closing it collapses the tree down to the
    // split-off sibling, which is still `focusedLeafId` — so `findLeaf(root,
    // panel.originLeafId)` in `redockTarget()` now fails and it must fall
    // back to `workspace.focusedLeafId` instead.
    await user.click(screen.getByText('close root leaf'));

    expect(screen.getByTestId('focused-leaf-tab-count')).toHaveTextContent('0');

    await user.click(screen.getByRole('button', { name: 'Dock this tab' }));

    expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
    // The tab landed in the surviving (focused) leaf, not a dead origin id.
    expect(screen.getByTestId('focused-leaf-tab-count')).toHaveTextContent('1');
  });

  it('a pointerdown on the window does not throw (setPointerCapture is unguarded nowhere)', async () => {
    const user = userEvent.setup();
    renderHarness();
    await openAndDetach(user);

    const dialog = screen.getByRole('dialog', { name: 'Inbox' });
    expect(() => fireEvent.pointerDown(dialog)).not.toThrow();
  });

  describe('title-bar drag', () => {
    function titleBar(): HTMLElement {
      // `.cursor-grab` is unique to the title bar — the drag surface.
      return screen
        .getByRole('dialog', { name: 'Inbox' })
        .querySelector('.cursor-grab') as HTMLElement;
    }

    it('ignores a pointermove/pointerup that arrive without an active drag', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 500, clientY: 500 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 500, clientY: 500 });

      // Position stays at the detach position; nothing was docked.
      expect(screen.getByTestId('panel-x')).toHaveTextContent('10');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('20');
      expect(screen.getByTestId('panel-count')).toHaveTextContent('1');
      expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');
    });

    it('ignores a pointermove/pointerup for a different pointer than the one that started the drag', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(bar, { pointerId: 2, clientX: 400, clientY: 400 });
      fireEvent.pointerUp(bar, { pointerId: 2, clientX: 400, clientY: 400 });

      expect(screen.getByTestId('panel-x')).toHaveTextContent('10');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('20');
      expect(screen.getByTestId('panel-count')).toHaveTextContent('1');
    });

    it('moves the panel as the pointer moves and docks it when released over a registered leaf', async () => {
      const user = userEvent.setup();
      renderHarness({ dropTarget: true });
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 150, clientY: 130 });

      // Origin (10,20) + delta (50,30) = (60,50), tracked live mid-drag —
      // via the rendered style (`liveRect`), since the persisted workspace
      // state (`panel-x`/`-y`) only catches up on a debounce or on release.
      expect(liveStyle().left).toBe('60px');
      expect(liveStyle().top).toBe('50px');

      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 150, clientY: 130 });

      // Drop-point centre: (60 + 360/2, 50 + 280/2) = (240, 190), inside the
      // registered (200,150)-(300,250) rect, so the tab redocks into root.
      expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
      expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('1');
    });

    it('flushes on release without error when the pointer never moved (nothing pending to flush)', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 100 });

      // No pointermove fired, so no persist was ever scheduled.
      expect(screen.getByTestId('panel-x')).toHaveTextContent('10');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('20');
    });

    it('debounces the persisted position during a drag, catching up 150ms after the last move', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderHarness();
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 150, clientY: 130 });

      // The persisted workspace state hasn't caught up yet — only the live
      // render has (asserted above) — proving the write is debounced rather
      // than firing on every tick.
      expect(screen.getByTestId('panel-x')).toHaveTextContent('10');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('20');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(screen.getByTestId('panel-x')).toHaveTextContent('60');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('50');

      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 150, clientY: 130 });
    });

    it('leaves the panel floating at its new position when released over no registered leaf', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 150, clientY: 130 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 150, clientY: 130 });

      expect(screen.getByTestId('panel-x')).toHaveTextContent('60');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('50');
      expect(screen.getByTestId('panel-count')).toHaveTextContent('1');
      expect(screen.getByTestId('leaf-tab-count')).toHaveTextContent('0');
    });

    it('clamps the drag to the overlay container so the window can never leave it off-screen', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      // happy-dom's `getBoundingClientRect()` always reports a zeroed rect
      // (no layout engine) — stub the overlay's positioning root with a
      // realistic measured size so the clamp branch actually engages, the
      // same technique `workspace-overlay-context.test.tsx` uses for the
      // same limitation.
      const overlayRoot = document.querySelector('.relative.h-full') as HTMLElement;
      vi.spyOn(overlayRoot, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 400,
        bottom: 300,
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const bar = titleBar();
      fireEvent.pointerDown(bar, { pointerId: 1, clientX: 100, clientY: 100 });

      // Dragged far past the bottom-right: clamped to the container's edge
      // (400 - 360 width = 40, 300 - 280 height = 20), not the raw delta.
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 900, clientY: 900 });
      expect(liveStyle().left).toBe('40px');
      expect(liveStyle().top).toBe('20px');

      // Dragged far past the top-left: clamped to 0, not negative — the
      // window's title bar (its only way back) stays reachable either way.
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: -900, clientY: -900 });
      expect(liveStyle().left).toBe('0px');
      expect(liveStyle().top).toBe('0px');

      fireEvent.pointerUp(bar, { pointerId: 1, clientX: -900, clientY: -900 });

      // The clamped end position is what gets persisted on release.
      expect(screen.getByTestId('panel-x')).toHaveTextContent('0');
      expect(screen.getByTestId('panel-y')).toHaveTextContent('0');
    });
  });

  describe('corner-handle resize', () => {
    function resizeHandle(): HTMLElement {
      // `.cursor-nwse-resize` is unique to the resize handle — a bare
      // `[aria-hidden="true"]` selector would instead match the title bar's
      // own icon svg (also `aria-hidden`), which sits earlier in the DOM.
      return screen
        .getByRole('dialog', { name: 'Inbox' })
        .querySelector('.cursor-nwse-resize') as HTMLElement;
    }

    it('ignores a pointermove/pointerup that arrive without an active resize', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 900 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900, clientY: 900 });

      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT));
    });

    it('ignores a pointermove/pointerup for a different pointer than the one that started the resize', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 500, clientY: 500 });
      fireEvent.pointerUp(handle, { pointerId: 2, clientX: 500, clientY: 500 });

      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT));
    });

    it('resizes the panel as the pointer drags the corner handle', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 170 });

      // Tracked live mid-resize via the rendered style — the persisted
      // workspace state only catches up on a debounce or on release.
      expect(liveStyle().width).toBe(`${DEFAULT_WIDTH + 40}px`);
      expect(liveStyle().height).toBe(`${DEFAULT_HEIGHT + 70}px`);

      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 140, clientY: 170 });

      // The size holds after release; nothing further changes it.
      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH + 40));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT + 70));
    });

    it('debounces the persisted size during a resize, catching up 150ms after the last move', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 170 });

      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH + 40));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT + 70));

      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 140, clientY: 170 });
    });

    it('clamps the resize to the floating panel minimum when dragged smaller', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: -400, clientY: -400 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: -400, clientY: -400 });

      // MIN_FLOATING_PANEL_WIDTH / MIN_FLOATING_PANEL_HEIGHT (floating-panels.ts).
      expect(screen.getByTestId('panel-width')).toHaveTextContent('240');
      expect(screen.getByTestId('panel-height')).toHaveTextContent('160');
    });

    it('further pointermove after release does not resize again', async () => {
      const user = userEvent.setup();
      renderHarness();
      await openAndDetach(user);

      const handle = resizeHandle();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 170 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 140, clientY: 170 });

      // The resize ref was cleared on pointerup — a stray move for the same
      // pointer id afterwards must not resize further.
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 900 });

      expect(screen.getByTestId('panel-width')).toHaveTextContent(String(DEFAULT_WIDTH + 40));
      expect(screen.getByTestId('panel-height')).toHaveTextContent(String(DEFAULT_HEIGHT + 70));
    });
  });
});
