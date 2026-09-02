// @vitest-environment happy-dom

/**
 * Unit Tests: TabStrip.
 *
 * Covers everything reachable without simulating a pointer drag: rendering,
 * click-to-activate, close, and the "+" launcher affordance. Reordering
 * itself is `reorderTab`'s pure-tree guarantee, already table-tested in
 * `split-tree.test.ts`.
 *
 * `onDragStart`/`onDragEnd`/`onDragCancel` are closures inside `TabStrip`,
 * not exported — so the seam used to reach them is the same one
 * `board-drag-end.test.tsx` uses for `BoardView`: mock `@dnd-kit/core`'s
 * `DndContext` (and `DragOverlay`, to skip its portal) just enough to
 * capture the three handler props dnd-kit would otherwise call after a real
 * pointer gesture, then invoke them directly with a synthetic event. This
 * exercises the branch logic — the drag-out-of-strip detach guard, the
 * reorder pass-through, the self-drop no-op — without needing jsdom to
 * drive dnd-kit's pointer-sensor maths, which it can't do reliably. The
 * gesture itself stays e2e/manual-only, per the file's original scope note.
 *
 * @see components/resparkable/workspace/tab-strip.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

/**
 * Capture `onDragStart` / `onDragEnd` / `onDragCancel` instead of rendering a
 * real drag context — see the file header comment. `useSortable` inside
 * `TabPill` stays real; only `DndContext` (to grab the handlers) and
 * `DragOverlay` (to skip the portal) are replaced.
 */
const captured: {
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: () => void;
} = {};

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: {
      children: React.ReactNode;
      onDragStart?: (event: DragStartEvent) => void;
      onDragEnd?: (event: DragEndEvent) => void;
      onDragCancel?: () => void;
    }) => {
      captured.onDragStart = props.onDragStart;
      captured.onDragEnd = props.onDragEnd;
      captured.onDragCancel = props.onDragCancel;
      return props.children;
    },
    DragOverlay: (props: { children?: React.ReactNode }) => props.children ?? null,
  };
});

import {
  useWorkspace,
  WorkspaceProvider,
} from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';
import { TabStrip } from '@/components/resparkable/workspace/tab-strip';
import { findLeaf, type LeafNode } from '@/lib/framework/resparkable/ui/workspace/split-tree';

const ROOT_LEAF_ID = 'root';

/** Opens two distinct tabs in the root leaf before rendering the strip against it. */
function Harness(): React.ReactElement {
  const workspace = useWorkspace();
  const leaf = findLeaf(workspace.root, ROOT_LEAF_ID) as LeafNode;

  return (
    <div>
      <button onClick={() => workspace.openTab('today')}>open today</button>
      <button onClick={() => workspace.openTab('inbox')}>open inbox</button>
      <TabStrip leafId={ROOT_LEAF_ID} tabs={leaf.tabs} activeTabId={leaf.activeTabId} />
      <div data-testid="active-tab-id">{leaf.activeTabId ?? 'null'}</div>
      <div data-testid="tab-count">{leaf.tabs.length}</div>
      <div data-testid="tab-ids">{leaf.tabs.map((tab) => tab.id).join(',')}</div>
      <div data-testid="floating-count">{workspace.floatingPanels.length}</div>
    </div>
  );
}

/** A `DOMRect`-shaped object — enough for `isPointInsideRect`/`centerOfRect`. */
function rect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * Stubs the two `getBoundingClientRect` calls `onDragEnd` makes: the strip's
 * own container (found via its `border-b` class, unique in this render) and
 * the overlay's positioning root (`WorkspaceOverlayProvider`'s `relative
 * h-full` div, also unique here).
 */
function stubGeometry(stripBox: DOMRect, overlayBox: DOMRect): void {
  const stripEl = screen.getByRole('list', { name: 'Open tabs' }).closest('.border-b');
  const overlayEl = document.querySelector('.relative.h-full');
  if (!stripEl || !overlayEl) throw new Error('geometry anchor elements not found');
  vi.spyOn(stripEl, 'getBoundingClientRect').mockReturnValue(stripBox);
  vi.spyOn(overlayEl, 'getBoundingClientRect').mockReturnValue(overlayBox);
}

function dragEndEvent(
  activeId: string,
  overId: string | null,
  translated: DOMRect | undefined
): DragEndEvent {
  return {
    active: { id: activeId, rect: { current: { translated } } },
    over: overId ? { id: overId } : null,
  } as unknown as DragEndEvent;
}

function renderStrip() {
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <Harness />
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  captured.onDragStart = undefined;
  captured.onDragEnd = undefined;
  captured.onDragCancel = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TabStrip', () => {
  it('renders each open tab by its default title', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));

    const strip = screen.getByRole('list', { name: 'Open tabs' });
    expect(within(strip).getByText('Today')).toBeInTheDocument();
    expect(within(strip).getByText('Inbox')).toBeInTheDocument();
  });

  it('renders the tab kind’s icon to the left of the label', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));

    const pill = screen.getByText('Today').closest('[role="button"]') as HTMLElement;
    const icon = pill.querySelector('svg');
    const label = screen.getByText('Today');
    expect(icon).toBeInTheDocument();
    // DOM order, not just presence — the icon precedes the label text node.
    expect(icon!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('activates a tab on click', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox')); // inbox is now active

    await user.click(screen.getByText('Today'));

    expect(screen.getByTestId('active-tab-id')).not.toHaveTextContent('null');
    // Today's pill carries aria-current once it's the active tab again.
    expect(screen.getByText('Today').closest('[role="button"]')).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('activates a tab via keyboard (Enter)', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));

    const todayPill = screen.getByText('Today').closest('[role="button"]') as HTMLElement;
    todayPill.focus();
    await user.keyboard('{Enter}');

    expect(todayPill).toHaveAttribute('aria-current', 'true');
  });

  it('closes a tab without activating a different one first', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    expect(screen.getByTestId('tab-count')).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'Close Today' }));

    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });

  it('the "+" button shows the launcher without closing any open tab', async () => {
    const user = userEvent.setup();
    renderStrip();

    await user.click(screen.getByText('open today'));
    await user.click(screen.getByRole('button', { name: 'Open something new' }));

    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('null');
    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
  });
});

describe('TabStrip — drag overlay (onDragStart / onDragCancel)', () => {
  it('shows a second, ghost copy of the dragged tab’s label once a drag starts', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    expect(screen.getAllByText('Today')).toHaveLength(1);

    act(() => {
      captured.onDragStart?.({ active: { id: todayId } } as unknown as DragStartEvent);
    });

    // TabPillGhost renders a second, independent copy of the label.
    expect(screen.getAllByText('Today')).toHaveLength(2);
  });

  it('clears the ghost copy when the drag is cancelled', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    act(() => {
      captured.onDragStart?.({ active: { id: todayId } } as unknown as DragStartEvent);
    });
    expect(screen.getAllByText('Today')).toHaveLength(2);

    act(() => {
      captured.onDragCancel?.();
    });

    expect(screen.getAllByText('Today')).toHaveLength(1);
  });

  it('shows no ghost copy when the started drag id matches no open tab', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));

    act(() => {
      captured.onDragStart?.({ active: { id: 'not-a-real-tab' } } as unknown as DragStartEvent);
    });

    expect(screen.getAllByText('Today')).toHaveLength(1);
  });
});

describe('TabStrip — onDragEnd', () => {
  const stripBox = rect(0, 500, 0, 50);
  const overlayBox = rect(0, 1000, 0, 1000);

  it('detaches the tab into a floating panel when the drop lands outside the strip', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    // Well outside the strip's box (0-500 x 0-50).
    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, null, rect(900, 950, 900, 950)));
    });

    expect(screen.getByTestId('floating-count')).toHaveTextContent('1');
    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
    expect(screen.getByTestId('tab-ids')).not.toHaveTextContent(todayId);
  });

  it('reorders tabs when the drop lands on a different tab inside the strip', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId, inboxId] = screen.getByTestId('tab-ids').textContent.split(',');
    // Well inside the strip's box.
    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, inboxId, rect(100, 150, 10, 30)));
    });

    expect(screen.getByTestId('tab-ids')).toHaveTextContent(`${inboxId},${todayId}`);
    expect(screen.getByTestId('floating-count')).toHaveTextContent('0');
  });

  it('does nothing when dropped back on its own slot', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    const before = screen.getByTestId('tab-ids').textContent;

    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, todayId, rect(100, 150, 10, 30)));
    });

    expect(screen.getByTestId('tab-ids')).toHaveTextContent(before ?? '');
    expect(screen.getByTestId('floating-count')).toHaveTextContent('0');
  });

  it('does nothing when the drop lands inside the strip with no target', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    const before = screen.getByTestId('tab-ids').textContent;

    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, null, rect(100, 150, 10, 30)));
    });

    expect(screen.getByTestId('tab-ids')).toHaveTextContent(before ?? '');
    expect(screen.getByTestId('floating-count')).toHaveTextContent('0');
  });

  it('does nothing when the drop target no longer matches any open tab', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId] = screen.getByTestId('tab-ids').textContent.split(',');
    const before = screen.getByTestId('tab-ids').textContent;

    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, 'not-a-real-tab-id', rect(100, 150, 10, 30)));
    });

    expect(screen.getByTestId('tab-ids')).toHaveTextContent(before ?? '');
    expect(screen.getByTestId('floating-count')).toHaveTextContent('0');
  });

  it('reorders instead of detaching when there is no translated rect to test against', async () => {
    const user = userEvent.setup();
    renderStrip();
    await user.click(screen.getByText('open today'));
    await user.click(screen.getByText('open inbox'));
    stubGeometry(stripBox, overlayBox);

    const [todayId, inboxId] = screen.getByTestId('tab-ids').textContent.split(',');
    // No `translated` rect — the detach guard's `if` short-circuits false,
    // so this must fall through to the ordinary reorder path.
    act(() => {
      captured.onDragEnd?.(dragEndEvent(todayId, inboxId, undefined));
    });

    expect(screen.getByTestId('tab-ids')).toHaveTextContent(`${inboxId},${todayId}`);
    expect(screen.getByTestId('floating-count')).toHaveTextContent('0');
  });
});
