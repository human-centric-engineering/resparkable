// @vitest-environment happy-dom

/**
 * TabCloseProvider / useOptionalTabClose Tests
 *
 * The seam that lets content inside a tab close that tab without knowing which
 * tab, or which pane, it is in. What it carries is an already-resolved
 * callback rather than an id, because "close me" is `closeTab(leafId, tabId)`
 * for a docked tab and `closeFloatingPanel(panelId)` for a detached one: two
 * actions in two id spaces that no single id could express.
 *
 * Test Coverage:
 * - The provider hands its callback through to a consumer unchanged
 * - The hook returns null with no provider, rather than throwing
 * - The innermost provider wins when two are nested
 *
 * @see components/resparkable/workspace/tabs/tab-close-context.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  TabCloseProvider,
  useOptionalTabClose,
} from '@/components/resparkable/workspace/tabs/tab-close-context';

/** Reports what the hook gave it, and calls it on demand. */
function Consumer(): React.ReactElement {
  const close = useOptionalTabClose();
  return (
    <button type="button" onClick={() => close?.()}>
      {close ? 'closable' : 'not closable'}
    </button>
  );
}

describe('useOptionalTabClose', () => {
  it('returns null outside any provider', () => {
    // Null rather than a throw: the components that call this are shared
    // between the workspace and a plain page under `app/`, and neither may
    // fail in the other's context.
    render(<Consumer />);
    expect(screen.getByRole('button')).toHaveTextContent('not closable');
  });

  it('hands the provider callback to a consumer', async () => {
    const user = userEvent.setup();
    const close = vi.fn();

    render(
      <TabCloseProvider close={close}>
        <Consumer />
      </TabCloseProvider>
    );

    await user.click(screen.getByRole('button', { name: 'closable' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reaches a consumer nested well below the provider', async () => {
    // The real consumer is `ArchiveControls`, several components down inside a
    // detail view. A context rather than a prop is the whole point.
    const user = userEvent.setup();
    const close = vi.fn();

    render(
      <TabCloseProvider close={close}>
        <div>
          <section>
            <Consumer />
          </section>
        </div>
      </TabCloseProvider>
    );

    await user.click(screen.getByRole('button'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('gives the innermost provider when two are nested', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();

    render(
      <TabCloseProvider close={outer}>
        <TabCloseProvider close={inner}>
          <Consumer />
        </TabCloseProvider>
      </TabCloseProvider>
    );

    await user.click(screen.getByRole('button'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
