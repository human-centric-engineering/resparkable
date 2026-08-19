'use client';

/**
 * GraphTab — the launcher-opened counterpart to `app/(protected)/resparkable/graph/page.tsx`.
 *
 * The build plan names this one explicitly as needing real work, and names
 * only `GraphView` as the component it reuses — not `GraphControls`, the
 * depth/node-cap picker. `GraphControls` reads and writes the real browser
 * URL (`useSearchParams()` / `router.push`) to change depth, which is
 * incompatible with a launcher-opened tab: there's no 1:1 URL for a tab,
 * and pushing one would misdirect `route-tab-bridge` (Phase 8) rather than
 * just changing this pane. So this fetches at the API's own default
 * depth/limit and has no picker — adding one is a real follow-up, not a
 * silent scope cut, since the plan's own wording already draws this line.
 *
 * `focus`/`focusType` come from the tab's params (`TabParams`, set by
 * whatever opened this tab — Sparkey, a graph node, an `EntityChip`'s "see
 * connections" link) rather than the URL. Same "pick something to look at"
 * empty state as the page when neither is set.
 */

import * as React from 'react';
import { Share2 } from 'lucide-react';

import { GraphView } from '@/components/resparkable/graph/graph-view';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { graphPayloadSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface GraphTabProps {
  focusType?: string;
  focus?: string;
}

export function GraphTab({ focusType, focus }: GraphTabProps): React.ReactElement {
  const endpoint =
    focusType && focus
      ? `${RESPARKABLE_API.GRAPH}?${new URLSearchParams({ focus, focusType }).toString()}`
      : null;

  const [state, retry] = useTabFetch(endpoint, graphPayloadSchema);

  if (endpoint === null) {
    return (
      <EmptyState
        icon={Share2}
        title="Pick something to look at"
        description="Open the graph from an item's connections to see what it links to."
      />
    );
  }

  if (state.status === 'loading') return <SkeletonList label="Loading graph" />;
  if (state.status === 'error') {
    return <TabLoadError what="the graph" message={state.message} onRetry={retry} />;
  }
  return <GraphView payload={state.data} />;
}
