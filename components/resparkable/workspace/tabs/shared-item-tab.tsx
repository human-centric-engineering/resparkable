'use client';

/**
 * SharedItemTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/shared/[entityType]/[entityId]/page.tsx`.
 *
 * **The 404 copy names no cause.** A revoked grant, an expired one, a deleted
 * item and a type that was never shareable all produce the same message, for
 * the same reason the route returns the same status for all four: a reader who
 * could tell them apart could use this screen to learn things about a brain
 * they have no access to.
 *
 * It also does **not** say "ask them to share it again", which was the obvious
 * copy and the wrong one — most of the time this screen appears because
 * somebody deliberately withdrew access, and prompting the reader to go and ask
 * about it turns a quiet decision into a conversation the owner did not choose
 * to have.
 */

import * as React from 'react';
import { FileQuestion } from 'lucide-react';

import { SharedItemDetail } from '@/components/resparkable/share/shared-item-detail';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useTabTitle } from '@/components/resparkable/workspace/tabs/use-tab-title';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { sharedItemDetailSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface SharedItemTabProps {
  tabId: string;
  entityType: string;
  id: string;
}

export function SharedItemTab({ tabId, entityType, id }: SharedItemTabProps): React.ReactElement {
  const [detail, retry] = useTabFetch(
    RESPARKABLE_API.sharedItem(entityType, id),
    sharedItemDetailSchema
  );

  useTabTitle(tabId, detail.status === 'ready' ? detail.data.item.title : null);

  if (detail.status === 'loading') return <SkeletonList label="Loading" />;
  if (detail.status === 'error') {
    if (detail.httpStatus === 404) {
      return (
        <EmptyState
          icon={FileQuestion}
          title="Not available"
          description="This is no longer shared with you, or the link is out of date."
        />
      );
    }
    return <TabLoadError what="this shared item" message={detail.message} onRetry={retry} />;
  }

  return <SharedItemDetail detail={detail.data} />;
}
