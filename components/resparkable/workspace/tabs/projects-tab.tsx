'use client';

/**
 * ProjectsTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/projects/page.tsx`.
 *
 * `status` is read from the real URL, same reasoning as `PlanTab`'s `day` —
 * and `ProjectsView` changes it via `router.push`, unmodified, the same
 * accepted quirk.
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { z } from 'zod';

import { ProjectsView } from '@/components/resparkable/projects/projects-view';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, projectSchema } from '@/lib/framework/resparkable/ui/payloads';
import { PROJECT_STATUSES } from '@/lib/framework/resparkable/validations';

const projectsSchema = z.array(projectSchema);
const areasSchema = z.array(areaSchema);

export function ProjectsTab(): React.ReactElement {
  const searchParams = useSearchParams();
  const raw = searchParams.get('status');
  const status = raw && (PROJECT_STATUSES as readonly string[]).includes(raw) ? raw : null;

  const query = new URLSearchParams({ limit: '200' });
  if (status) query.set('status', status);

  const [projects, retryProjects] = useTabFetch(
    `${RESPARKABLE_API.PROJECTS}?${query.toString()}`,
    projectsSchema
  );
  const [areas] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  if (projects.status === 'loading') return <SkeletonList label="Loading projects" />;
  if (projects.status === 'error') {
    return <TabLoadError what="your projects" message={projects.message} onRetry={retryProjects} />;
  }

  return (
    <ProjectsView
      projects={projects.data}
      areas={areas.status === 'ready' ? areas.data : []}
      status={status}
    />
  );
}
