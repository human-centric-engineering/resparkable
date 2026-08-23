'use client';

/**
 * PlanTab — the launcher-opened counterpart to `app/(resparkable)/resparkable/plan/page.tsx`.
 *
 * ## The day is this tab's own, not the browser's
 *
 * This adapter used to read `?day=` out of `useSearchParams()` and let
 * `DayPlanner` change it with `router.push`. Both halves were wrong once two
 * panes could be open at once: every Plan tab in the workspace reads the same
 * search params, so stepping to tomorrow in one pane stepped every other Plan
 * pane with it — and moved the address bar, which belongs to whichever tab is
 * the tree's single `source: 'route'` tab, not to this one.
 *
 * The day now arrives as a prop off `tab.params` and is written back with
 * `setTabParams`, which touches no URL. `DayPlanner` itself is unmodified
 * except for one optional `onDayChange` callback: absent (the real
 * `plan/page.tsx`, and the route-backed tab that renders it) it still
 * navigates exactly as before, because for that one tab the URL genuinely is
 * its identity.
 *
 * Saving or deleting a block needs no prop here at all: `DayPlanner` and the
 * `CreateDialog` under it both call `useResparkableRefresh()`, which resolves
 * to this tab's own refetch (see `tab-refresh-context.tsx`).
 *
 * `day` being absent means "today" rather than a date pinned at open time, so
 * a Plan tab left open overnight shows the new day rather than yesterday's.
 * `todayIso()` runs in the **browser's** local time rather than the server's,
 * which the original page's own comment flags as a known simplification —
 * this adapter is, if anything, more correct than the page it replaces.
 */

import * as React from 'react';
import { z } from 'zod';

import { DayPlanner } from '@/components/resparkable/plan/day-planner';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';
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

export interface PlanTabProps {
  /** This tab's id — what `setTabParams` writes the day back through. */
  tabId: string;
  /** From `tab.params.day`. Absent means today, resolved on every render. */
  day?: string;
}

export function PlanTab({ tabId, day: dayParam }: PlanTabProps): React.ReactElement {
  const { setTabParams } = useWorkspace();
  const day = dayParam && DAY_PATTERN.test(dayParam) ? dayParam : todayIso();

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

  const onDayChange = React.useCallback(
    (next: string) => setTabParams(tabId, { day: next }),
    [setTabParams, tabId]
  );

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
      onDayChange={onDayChange}
    />
  );
}
