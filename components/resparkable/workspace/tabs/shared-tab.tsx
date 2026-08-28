'use client';

/**
 * SharedTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/shared/page.tsx`.
 */

import * as React from 'react';

import { SharedWithMeView } from '@/components/resparkable/share/shared-with-me-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { sharedWithMeListSchema } from '@/lib/framework/resparkable/ui/payloads';

export function SharedTab(): React.ReactElement {
  const [shared, retry] = useTabFetch(RESPARKABLE_API.SHARED, sharedWithMeListSchema);

  if (shared.status === 'loading') return <SkeletonList label="Loading what has been shared" />;
  if (shared.status === 'error') {
    return (
      <TabLoadError what="what has been shared with you" message={shared.message} onRetry={retry} />
    );
  }
  return <SharedWithMeView items={shared.data} />;
}
