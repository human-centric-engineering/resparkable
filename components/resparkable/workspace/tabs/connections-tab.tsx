'use client';

/**
 * ConnectionsTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/connections/page.tsx`.
 *
 * The server page passes `total={result.meta?.total ?? result.data.length}`
 * — `apiClient.get()` (`lib/api/client.ts`) unwraps the envelope down to
 * just `data`, discarding `meta` for every caller in the app, not only
 * here. So `total` can only ever be `data.length` from a client fetch,
 * which under-counts past this endpoint's `limit=50` if there are more
 * than 50 pending connections. Fixing that would mean changing what
 * `apiClient.get()` returns everywhere, well outside this phase's scope —
 * flagged here rather than silently shipping a number that's quietly wrong
 * once someone has a large queue.
 */

import * as React from 'react';

import { ConnectionsView } from '@/components/resparkable/connections/connections-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { connectionRowsSchema } from '@/lib/framework/resparkable/ui/payloads';

export function ConnectionsTab(): React.ReactElement {
  const [connections, retry] = useTabFetch(
    `${RESPARKABLE_API.CONNECTIONS}?limit=50`,
    connectionRowsSchema
  );

  if (connections.status === 'loading') return <SkeletonList label="Loading connections" />;
  if (connections.status === 'error') {
    return <TabLoadError what="your connections" message={connections.message} onRetry={retry} />;
  }
  return <ConnectionsView connections={connections.data} total={connections.data.length} />;
}
