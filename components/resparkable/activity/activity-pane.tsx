'use client';

/**
 * ActivityPane — the discovery feed: everything the sweep has noticed and
 * nobody has decided about yet.
 *
 * Standalone pane, not a Workspace tab — same shape as `SparkeyPane`
 * (Phase 4): it sits directly inside `WorkspaceProvider` next to Sparkey and
 * the Workspace pane tree, with no entry in `tab-registry.ts` and no tab
 * strip of its own.
 *
 * Fetches with `useTabFetch` (its name is a Phase 3 leftover — the hook
 * itself is generic, just `apiClient.get()` + Zod, and reusing it here beats
 * writing a second copy of the same fetch-then-validate effect for a pane
 * that doesn't happen to be a tab) against the same `connectionRowsSchema`
 * `ConnectionsView` validates against.
 *
 * Accept/reject is a local, in-place removal on top of `PATCH /links/:id` —
 * no `router.refresh()`. There is no server-rendered route beneath this
 * pane to re-run, and even if there were, refreshing the current route
 * segment would reflow every other pane sitting on it too (the same trap
 * flagged for `ConnectionsTab` in the plan's deferred-follow-ups). A failed
 * PATCH rolls the row back into view rather than leaving it hidden.
 */

import * as React from 'react';
import { Link2, Waves } from 'lucide-react';

import { DiscoveryCard } from '@/components/resparkable/activity/discovery-card';
import type { ActivityItem } from '@/components/resparkable/activity/activity-types';
import { PaneRail } from '@/components/resparkable/shell/pane-rail';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { connectionRowsSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface ActivityPaneProps {
  /** True once `WorkspaceShell`'s Activity panel has collapsed to a rail. */
  collapsed?: boolean;
  /** Expands the panel — wired to `PaneRail`'s click, not a button this pane renders itself. */
  onExpand?: () => void;
}

export function ActivityPane({
  collapsed = false,
  onExpand,
}: ActivityPaneProps = {}): React.ReactElement {
  const [connections, retry] = useTabFetch(
    `${RESPARKABLE_API.CONNECTIONS}?limit=50`,
    connectionRowsSchema
  );
  const review = useSaveStatus();
  const [reviewed, setReviewed] = React.useState<Set<string>>(new Set());

  async function decide(id: string, status: 'accepted' | 'rejected'): Promise<void> {
    setReviewed((current) => new Set(current).add(id));

    const ok = await review.run(() =>
      apiClient.patch(RESPARKABLE_API.linkById(id), { body: { status } })
    );

    if (!ok) {
      setReviewed((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  const items: ActivityItem[] =
    connections.status === 'ready'
      ? connections.data
          .filter((row) => !reviewed.has(row.id))
          .map((row) => ({ kind: 'discovery', connection: row }))
      : [];

  if (collapsed) {
    return <PaneRail label="Activity" side="right" icon={Waves} onExpand={onExpand} />;
  }

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-3">
        <Waves className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
        <h2 className="font-display text-sm font-semibold tracking-wide">Activity</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {connections.status === 'loading' && <SkeletonList label="Loading activity" />}
        {connections.status === 'error' && (
          <TabLoadError what="your activity" message={connections.message} onRetry={retry} />
        )}
        {connections.status === 'ready' && items.length === 0 && (
          <EmptyState
            icon={Link2}
            title="Nothing waiting"
            description="The sweep compares what you've already captured and turns up anything it thinks is related here."
            className="m-3"
          />
        )}
        {connections.status === 'ready' && items.length > 0 && (
          <>
            <p className="text-muted-foreground p-3 pb-0 text-xs">
              {items.length} {items.length === 1 ? 'discovery' : 'discoveries'} waiting on a
              decision.
            </p>
            <ul aria-label="Discoveries" className="space-y-2 p-3">
              {items.map((item) => (
                <DiscoveryCard
                  key={item.connection.id}
                  item={item}
                  onDecide={(id, status) => void decide(id, status)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {connections.status === 'ready' && items.length > 0 && (
        <SaveStatus state={review.state} message={review.message} className="px-3 pb-2" />
      )}
    </div>
  );
}
