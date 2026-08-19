'use client';

/**
 * TodayTab — the launcher-opened counterpart to `app/(protected)/resparkable/page.tsx`.
 *
 * Same fetch, same schema, same view, ported from a server `readResparkable`
 * call to `useTabFetch` (`use-tab-fetch.ts`'s header explains why). Every
 * adapter in this directory follows this exact shape unless its own file
 * says otherwise.
 */

import * as React from 'react';

import { TodayView } from '@/components/resparkable/today/today-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { todayPayloadSchema } from '@/lib/framework/resparkable/ui/payloads';

export function TodayTab(): React.ReactElement {
  const [state, retry] = useTabFetch(RESPARKABLE_API.TODAY, todayPayloadSchema);

  if (state.status === 'loading') return <SkeletonList label="Loading today" />;
  if (state.status === 'error') {
    return <TabLoadError what="your day" message={state.message} onRetry={retry} />;
  }
  return <TodayView payload={state.data} />;
}
