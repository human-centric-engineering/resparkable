// @vitest-environment happy-dom

/**
 * Unit Tests: the refresh seam.
 *
 * The whole value of this module is that one hook does two different things
 * depending on where it is rendered, so both halves are asserted directly:
 * inside a `TabRefreshBoundary` it bumps a generation and `router.refresh()`
 * is never called; outside one it calls `router.refresh()` and nothing else.
 *
 * The third case is the one the shell actually depends on and the one a
 * per-component fix would have missed: two boundaries side by side refresh
 * **independently**. That is the regression this replaced — every mutating
 * control called `router.refresh()`, which refetches the whole route segment
 * that every pane in the workspace sits under, so a card drag in one pane
 * refetched an unrelated tab two panes over.
 *
 * The fourth block covers the half a boundary cannot do alone: a write from
 * outside every tab (Sparkey, Activity) naming what it touched, and only the
 * tabs that show that thing catching up. Asserted through the real
 * `DataChangeProvider` rather than a stub, because the thing worth protecting
 * is the *pairing* — `change-scope.ts`'s key algebra on both sides — and a
 * stub would let the two drift apart while the test stayed green.
 *
 * @see components/resparkable/workspace/tabs/tab-refresh-context.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { DataChangeProvider } from '@/components/resparkable/workspace/data-change-context';
import {
  TabRefreshBoundary,
  useResparkableRefresh,
  useTabRefreshGeneration,
} from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import type {
  TabKind,
  TabParams,
  TabState,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

const routerRefresh = vi.fn();

/** A stand-in for any mutating control: a button that refreshes, and the generation it sees. */
function Probe({ label }: { label: string }): React.ReactElement {
  const refresh = useResparkableRefresh();
  const generation = useTabRefreshGeneration();
  return (
    <div>
      <button type="button" onClick={() => refresh()}>
        {label}
      </button>
      <span data-testid={`${label}-generation`}>{generation}</span>
    </div>
  );
}

/**
 * A writer that is not inside any tab — the Sparkey/Activity case. Names what
 * it touched, which is the only thing that can reach a tab from out here.
 */
function OutsideWriter({
  label,
  change,
}: {
  label: string;
  change: Parameters<ReturnType<typeof useResparkableRefresh>>[0];
}): React.ReactElement {
  const refresh = useResparkableRefresh();
  return (
    <button type="button" onClick={() => refresh(change)}>
      {label}
    </button>
  );
}

let nextTabId = 0;
function tab(kind: TabKind, params: TabParams = {}): TabState {
  nextTabId += 1;
  return { id: `tab-${nextTabId}`, kind, params, source: 'launcher' };
}

beforeEach(() => {
  routerRefresh.mockReset();
  vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh: routerRefresh }));
});

describe('useResparkableRefresh — outside a boundary', () => {
  it('falls back to router.refresh(), so a real page behaves exactly as it did before', async () => {
    const user = userEvent.setup();
    render(<Probe label="a" />);

    await user.click(screen.getByRole('button', { name: 'a' }));

    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('reports generation 0, so useTabFetch has a stable dep outside a tab', () => {
    render(<Probe label="a" />);

    expect(screen.getByTestId('a-generation')).toHaveTextContent('0');
  });
});

describe('useResparkableRefresh — inside a boundary', () => {
  it('bumps the generation instead of refreshing the route', async () => {
    const user = userEvent.setup();
    render(
      <TabRefreshBoundary tab={tab('inbox')}>
        <Probe label="a" />
      </TabRefreshBoundary>
    );

    await user.click(screen.getByRole('button', { name: 'a' }));

    expect(screen.getByTestId('a-generation')).toHaveTextContent('1');
    // The point of the whole module: the route segment every other pane sits
    // under is never refetched.
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('accumulates across repeated refreshes rather than toggling', async () => {
    const user = userEvent.setup();
    render(
      <TabRefreshBoundary tab={tab('inbox')}>
        <Probe label="a" />
      </TabRefreshBoundary>
    );

    await user.click(screen.getByRole('button', { name: 'a' }));
    await user.click(screen.getByRole('button', { name: 'a' }));

    expect(screen.getByTestId('a-generation')).toHaveTextContent('2');
  });
});

describe('two boundaries — one per tab', () => {
  it('refreshes only the tab the mutation happened in', async () => {
    const user = userEvent.setup();
    render(
      <>
        <TabRefreshBoundary tab={tab('inbox')}>
          <Probe label="a" />
        </TabRefreshBoundary>
        <TabRefreshBoundary tab={tab('projects')}>
          <Probe label="b" />
        </TabRefreshBoundary>
      </>
    );

    await user.click(screen.getByRole('button', { name: 'a' }));

    expect(screen.getByTestId('a-generation')).toHaveTextContent('1');
    expect(screen.getByTestId('b-generation')).toHaveTextContent('0');
  });
});

describe('a write from outside every tab', () => {
  it('reaches the tabs showing what changed, and leaves the others alone', async () => {
    const user = userEvent.setup();
    render(
      <DataChangeProvider>
        <OutsideWriter label="capture" change={{ type: 'thought' }} />
        <TabRefreshBoundary tab={tab('inbox')}>
          <Probe label="inbox" />
        </TabRefreshBoundary>
        <TabRefreshBoundary tab={tab('projects')}>
          <Probe label="projects" />
        </TabRefreshBoundary>
      </DataChangeProvider>
    );

    await user.click(screen.getByRole('button', { name: 'capture' }));

    // Inbox lists thoughts, so it catches up. Projects does not, so it holds
    // still — the whole reason this is a broadcast and not a global refresh.
    expect(screen.getByTestId('inbox-generation')).toHaveTextContent('1');
    expect(screen.getByTestId('projects-generation')).toHaveTextContent('0');
  });

  it('reaches the detail tab for the named record and no other of the same kind', async () => {
    const user = userEvent.setup();
    render(
      <DataChangeProvider>
        <OutsideWriter label="edit" change={{ type: 'project', id: 'p1' }} />
        <TabRefreshBoundary tab={tab('project', { id: 'p1' })}>
          <Probe label="p1" />
        </TabRefreshBoundary>
        <TabRefreshBoundary tab={tab('project', { id: 'p2' })}>
          <Probe label="p2" />
        </TabRefreshBoundary>
      </DataChangeProvider>
    );

    await user.click(screen.getByRole('button', { name: 'edit' }));

    expect(screen.getByTestId('p1-generation')).toHaveTextContent('1');
    expect(screen.getByTestId('p2-generation')).toHaveTextContent('0');
  });

  it('reaches every detail tab of a kind when the writer cannot name the record', async () => {
    const user = userEvent.setup();
    render(
      <DataChangeProvider>
        {/* An instruct turn: the stream says `resparkable_upsert_project` ran,
            never which project it wrote. Both open project tabs are suspect. */}
        <OutsideWriter label="instruct" change={{ type: 'project' }} />
        <TabRefreshBoundary tab={tab('project', { id: 'p1' })}>
          <Probe label="p1" />
        </TabRefreshBoundary>
        <TabRefreshBoundary tab={tab('project', { id: 'p2' })}>
          <Probe label="p2" />
        </TabRefreshBoundary>
      </DataChangeProvider>
    );

    await user.click(screen.getByRole('button', { name: 'instruct' }));

    expect(screen.getByTestId('p1-generation')).toHaveTextContent('1');
    expect(screen.getByTestId('p2-generation')).toHaveTextContent('1');
  });

  it('still refreshes the route, so the route-backed tab is not left behind', async () => {
    const user = userEvent.setup();
    render(
      <DataChangeProvider>
        <OutsideWriter label="capture" change={{ type: 'thought' }} />
      </DataChangeProvider>
    );

    await user.click(screen.getByRole('button', { name: 'capture' }));

    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});
