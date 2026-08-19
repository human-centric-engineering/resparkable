'use client';

/**
 * ProjectTab — the launcher-opened counterpart to
 * `app/(protected)/resparkable/projects/[id]/page.tsx`.
 *
 * The server page calls `notFound()` on a 404, which renders the route
 * group's `not-found.tsx` — the *whole page*. A tab's 404 must stay
 * scoped to the one pane it happened in, so this renders its own inline
 * not-found state instead of reaching for that boundary.
 */

import * as React from 'react';
import { FileQuestion } from 'lucide-react';
import { z } from 'zod';

import { ProjectDetail } from '@/components/resparkable/projects/project-detail';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, projectViewSchema } from '@/lib/framework/resparkable/ui/payloads';

const areasSchema = z.array(areaSchema);

export interface ProjectTabProps {
  id: string;
}

export function ProjectTab({ id }: ProjectTabProps): React.ReactElement {
  const [view, retryView] = useTabFetch(
    RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, id),
    projectViewSchema
  );
  const [areas] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  if (view.status === 'loading') return <SkeletonList label="Loading project" />;
  if (view.status === 'error') {
    if (view.httpStatus === 404) {
      return (
        <EmptyState
          icon={FileQuestion}
          title="Project not found"
          description="It may have been deleted, or the link is out of date."
        />
      );
    }
    return <TabLoadError what="this project" message={view.message} onRetry={retryView} />;
  }

  return <ProjectDetail view={view.data} areas={areas.status === 'ready' ? areas.data : []} />;
}
