'use client';

/**
 * RouteTabBridge — turns the browser's real URL into the tree's one
 * route-backed tab, and hands that tab the real, server-rendered page
 * output it's holding as `children`.
 *
 * `{children}` here is exactly what `app/(resparkable)/resparkable/layout.tsx`
 * was passed by Next.js for whatever route just matched — the real SSR
 * output of that route's own `page.tsx`, untouched. This is what keeps
 * every existing deep link, bookmark and email link resolving through
 * normal Next navigation (see the build plan's "route-backed vs.
 * launcher-opened tabs" section): the URL still does the routing, this
 * component just also tells `WorkspaceProvider` which pane should be
 * showing it.
 *
 * `focusType`/`focus` (Graph) and `q` (Search) travel as query params,
 * which `resolveTabForPathname` — a pathname-only matcher — can't see; this
 * is the one place that reads `useSearchParams()`, and hands it to
 * `mergeQueryParamsForTab`, which owns the per-kind keys next to each
 * entry's own `buildRoute` in `tab-registry.ts`.
 *
 * A pathname that doesn't resolve to any `TabKind` (there is no such route
 * under `/resparkable/**` today, but `resolveTabForPathname` returns `null`
 * rather than throwing for one) is a no-op: whatever route tab already
 * exists keeps showing, and `{children}` for a route with no matching kind
 * is simply never displayed by this bridge. That's a real gap, not
 * expected to be reachable — every `page.tsx` under `/resparkable/**` has
 * an entry in `tab-registry.ts`, and `tab-registry.test.ts`'s coverage
 * block asserts it stays that way.
 */

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { WorkspacePaneTree } from '@/components/resparkable/workspace/workspace-pane-tree';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import {
  mergeQueryParamsForTab,
  resolveTabForPathname,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface RouteTabBridgeProps {
  children: React.ReactNode;
}

export function RouteTabBridge({ children }: RouteTabBridgeProps): React.ReactElement {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspace = useWorkspace();
  const { syncRouteTab } = workspace;

  React.useEffect(() => {
    const resolved = resolveTabForPathname(pathname);
    if (!resolved) return;
    syncRouteTab(
      resolved.kind,
      mergeQueryParamsForTab(resolved.kind, resolved.params, searchParams)
    );
  }, [pathname, searchParams, syncRouteTab]);

  return <WorkspacePaneTree node={workspace.root} routeContent={children} />;
}
