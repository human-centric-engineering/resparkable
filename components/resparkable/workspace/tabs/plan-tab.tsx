'use client';

/**
 * PlanTab — the launcher-opened counterpart to `app/(protected)/resparkable/plan/page.tsx`.
 *
 * `day` has no home in `TabParams` (`tab-registry.ts`) because the route
 * itself never carried it in the path, only as a `?day=` search param — so
 * this reads it the same way the server page did, just from
 * `useSearchParams()` instead of an awaited `searchParams` prop. `today()`
 * runs in the **browser's** local time rather than the server's, which the
 * original page's own comment flags as a known simplification — this
 * adapter is, if anything, more correct than the page it replaces.
 *
 * `DayPlanner` changes the day by `router.push`-ing `?day=...` on the real
 * URL, unmodified — same accepted quirk as `ProjectsView`'s status filter:
 * Graph and Board are the two kinds this build plan calls out for
 * navigation-behavior changes, not Plan.
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { z } from 'zod';

import { DayPlanner } from '@/components/resparkable/plan/day-planner';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  areaSchema,
  projectSchema,
  timeBlockSchema,
} from '@/lib/framework/resparkable/ui/payloads';

const timeBlocksSchema = z.array(timeBlockSchema);
const activeProjectsSchema = z.array(projectSchema);
const areasSchema = z.array(areaSchema);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${date}`;
}

export function PlanTab(): React.ReactElement {
  const searchParams = useSearchParams();
  const raw = searchParams.get('day');
  const day = raw && DAY_PATTERN.test(raw) ? raw : todayIso();

  const from = new Date(`${day}T00:00:00`);
  const to = new Date(`${day}T23:59:59`);
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    limit: '100',
  });

  const [blocks, retryBlocks] = useTabFetch(
    `${RESPARKABLE_API.TIME_BLOCKS}?${query.toString()}`,
    timeBlocksSchema
  );
  const [projects] = useTabFetch(
    `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
    activeProjectsSchema
  );
  const [areas] = useTabFetch(`${RESPARKABLE_API.AREAS}?limit=200`, areasSchema);

  if (blocks.status === 'loading') return <SkeletonList label="Loading your day" />;
  if (blocks.status === 'error') {
    return <TabLoadError what="your day" message={blocks.message} onRetry={retryBlocks} />;
  }

  return (
    <DayPlanner
      key={day}
      blocks={blocks.data}
      projects={projects.status === 'ready' ? projects.data : []}
      areas={areas.status === 'ready' ? areas.data : []}
      day={day}
    />
  );
}
