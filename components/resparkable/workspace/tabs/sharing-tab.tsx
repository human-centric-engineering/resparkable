'use client';

/**
 * SharingTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/sharing/page.tsx`.
 */

import * as React from 'react';

import { MySharesView } from '@/components/resparkable/share/my-shares-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { mySharesSchema } from '@/lib/framework/resparkable/ui/payloads';

export function SharingTab(): React.ReactElement {
  const [shares, retry] = useTabFetch(RESPARKABLE_API.SHARES, mySharesSchema);

  if (shares.status === 'loading') return <SkeletonList label="Loading what you have shared" />;
  if (shares.status === 'error') {
    return <TabLoadError what="what you have shared" message={shares.message} onRetry={retry} />;
  }
  return <MySharesView items={shares.data} />;
}
