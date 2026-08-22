'use client';

/**
 * ProjectsTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/projects/page.tsx`.
 *
 * `status` is this tab's own, not the browser's — same reasoning as
 * `PlanTab`'s `day`, and the same mechanism: it arrives off `tab.params` and
 * `ProjectsView`'s filter writes it back through `setTabParams` rather than
 * `router.push`. Before that, both Projects panes read one `useSearchParams()`
 * and changing the filter in either changed both.
 *
 * `ProjectsView` itself is otherwise unmodified: without an `onStatusChange`
 * prop it still navigates, which is what the real page wants.
 */

import * as React from 'react';
import { z } from 'zod';

import { ProjectsView } from '@/components/resparkable/projects/projects-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, projectSchema } from '@/lib/framework/resparkable/ui/payloads';
import { PROJECT_STATUSES } from '@/lib/framework/resparkable/validations';

const projectsSchema = z.array(projectSchema);
const areasSchema = z.array(areaSchema);

export interface ProjectsTabProps {
  /** This tab's id — what `setTabParams` writes the status back through. */
  tabId: string;
  /** From `tab.params.status`. `null` means every project. */
  status: string | null;
}

export function ProjectsTab({ tabId, status: statusParam }: ProjectsTabProps): React.ReactElement {
  const { setTabParams } = useWorkspace();
  // Validated rather than trusted even though this is internal state: a
  // `resparkable.workspace.v2` blob is user-editable localStorage, and an
  // unknown status would otherwise reach the endpoint as a filter it rejects.
  const status =
    statusParam && (PROJECT_STATUSES as readonly string[]).includes(statusParam)
      ? statusParam
      : null;

  const query = new URLSearchParams({ limit: '200' });
  if (status) query.set('status', status);

  const [projects, retryProjects] = useTabFetch(
    `${RESPARKABLE_API.PROJECTS}?${query.toString()}`,
    projectsSchema
  );
  const [areas] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  const onStatusChange = React.useCallback(
    // `undefined`, not `null` — `setTabParams` merges its patch, and an
    // explicit `undefined` is what clears the key back to "every project".
    (next: string | null) => setTabParams(tabId, { status: next ?? undefined }),
    [setTabParams, tabId]
  );

  if (projects.status === 'loading') return <SkeletonList label="Loading projects" />;
  if (projects.status === 'error') {
    return <TabLoadError what="your projects" message={projects.message} onRetry={retryProjects} />;
  }

  return (
    <ProjectsView
      projects={projects.data}
      areas={areas.status === 'ready' ? areas.data : []}
      status={status}
      onStatusChange={onStatusChange}
    />
  );
}
