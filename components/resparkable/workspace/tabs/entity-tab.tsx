'use client';

/**
 * EntityTab — the launcher-opened counterpart to
 * `app/(resparkable)/resparkable/entities/[id]/page.tsx`. See `ProjectTab`
 * for why a 404 renders inline instead of reaching for `notFound()`.
 */

import * as React from 'react';
import { FileQuestion } from 'lucide-react';

import { EntityDetail } from '@/components/resparkable/entities/entity-detail';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useTabTitle } from '@/components/resparkable/workspace/tabs/use-tab-title';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { entityViewSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface EntityTabProps {
  /** This tab's id — what `useTabTitle` names once the person's own name is known. */
  tabId: string;
  id: string;
}

export function EntityTab({ tabId, id }: EntityTabProps): React.ReactElement {
  const [view, retry] = useTabFetch(
    RESPARKABLE_API.viewPath(RESPARKABLE_API.ENTITIES, id),
    entityViewSchema
  );

  useTabTitle(tabId, view.status === 'ready' ? view.data.entity.name : null);

  if (view.status === 'loading') return <SkeletonList label="Loading" />;
  if (view.status === 'error') {
    if (view.httpStatus === 404) {
      return (
        <EmptyState
          icon={FileQuestion}
          title="Not found"
          description="This person or company may have been deleted, or the link is out of date."
        />
      );
    }
    return <TabLoadError what="this person or company" message={view.message} onRetry={retry} />;
  }

  return <EntityDetail view={view.data} />;
}
