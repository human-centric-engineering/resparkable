'use client';

/**
 * GroupsTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/groups/page.tsx`.
 */

import * as React from 'react';

import { GroupsView } from '@/components/resparkable/groups/groups-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { groupsListSchema } from '@/lib/framework/resparkable/ui/payloads';

export function GroupsTab(): React.ReactElement {
  const [groups, retry] = useTabFetch(RESPARKABLE_API.GROUPS, groupsListSchema);

  if (groups.status === 'loading') return <SkeletonList label="Loading your groups" />;
  if (groups.status === 'error') {
    return <TabLoadError what="your groups" message={groups.message} onRetry={retry} />;
  }
  return <GroupsView initial={groups.data} />;
}
