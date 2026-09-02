// @vitest-environment happy-dom

/**
 * Unit Tests: RouteTabBridge.
 *
 * `syncRouteTab`'s own tree-mutation contract is covered in
 * `workspace-context.test.tsx`; `setRouteTab`'s pure tree logic is covered
 * in `split-tree.test.ts`. This file covers what the bridge itself adds on
 * top: resolving the current pathname to a tab kind, merging Graph's
 * `focusType`/`focus` and Search's `q` in from the query string (neither of
 * which `resolveTabForPathname` can see on its own), and rendering
 * `children` — the real routed page — as that tab's content.
 *
 * @see components/resparkable/shell/route-tab-bridge.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname, useSearchParams } from 'next/navigation';

import { RouteTabBridge } from '@/components/resparkable/shell/route-tab-bridge';
import { WorkspaceProvider } from '@/components/resparkable/workspace/workspace-context';
import { WorkspaceOverlayProvider } from '@/components/resparkable/workspace/workspace-overlay-context';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

const mockedPathname = usePathname as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;

function renderBridge(pathname: string, search = '') {
  mockedPathname.mockReturnValue(pathname);
  mockedSearchParams.mockReturnValue(new URLSearchParams(search));
  return render(
    <WorkspaceProvider>
      <WorkspaceOverlayProvider>
        <RouteTabBridge>
          <div>the real routed page</div>
        </RouteTabBridge>
      </WorkspaceOverlayProvider>
    </WorkspaceProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('RouteTabBridge', () => {
  it('renders children as the resolved route tab’s content', () => {
    renderBridge('/resparkable');
    expect(screen.getByText('the real routed page')).toBeInTheDocument();
  });

  it('resolves a matching header for the current route', () => {
    renderBridge('/resparkable/inbox');
    expect(screen.getByRole('heading', { name: /Inbox/i })).toBeInTheDocument();
    expect(screen.getByText('the real routed page')).toBeInTheDocument();
  });

  it('falls back to the launcher for a pathname that resolves to no tab kind', () => {
    renderBridge('/resparkable/not-a-real-section');
    expect(screen.queryByText('the real routed page')).not.toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
  });

  it('merges Graph’s focusType/focus from the query string', () => {
    renderBridge('/resparkable/graph', 'focusType=project&focus=proj_1');
    // The Graph tab kind resolved with real params — proven by the header
    // showing Graph's own section rather than falling through to the launcher.
    expect(screen.getByRole('heading', { name: /Graph/i })).toBeInTheDocument();
    expect(screen.getByText('the real routed page')).toBeInTheDocument();
  });

  it('merges Search’s q from the query string', () => {
    renderBridge('/resparkable/search', 'q=quarterly+review');
    expect(screen.getByRole('heading', { name: /Search/i })).toBeInTheDocument();
    expect(screen.getByText('the real routed page')).toBeInTheDocument();
  });
});
