'use client';

/**
 * DayPlanner — blocking out time, which is what turns a list into a plan.
 *
 * ## Why this screen exists at all
 *
 * One of the scorer's five factors is inert without it. `effortFit` compares a
 * task's estimate to the largest free gap in your day. With no time blocks, it is
 * always the neutral 0.5. The ranking still works; it is just quieter than it
 * should be, in a way nothing on screen explains. So this page says so.
 *
 * ## Times are local, and that is the one subtlety
 *
 * A `datetime-local` input has no timezone, so the browser's zone decides the instant.
 * That matches how people plan a day — you block 2pm because you mean 2pm where you
 * are — and it is deliberately *not* the same rule as snooze presets, which resolve in
 * `ResparkableSpace.timezone` on the server because they have to mean one instant from
 * every client. The distinction: a block is a thing you are looking at, a snooze is a
 * thing that fires.
 *
 * A day at a time. Blocking out a week in one screen is a calendar, and this is not
 * trying to be one.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange, Plus, Trash2 } from 'lucide-react';

import { TimeBlockForm } from '@/components/resparkable/plan/time-block-form';
import { formatMinutes } from '@/components/resparkable/today/task-row';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { useResparkableRefresh } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { AreaWire, ProjectWire, TimeBlockWire } from '@/lib/framework/resparkable/ui/payloads';

export interface DayPlannerProps {
  blocks: TimeBlockWire[];
  projects: ProjectWire[];
  areas: AreaWire[];
  /** `yyyy-mm-dd`. On the real page this comes from the URL; in a Workspace tab, from that tab's own params. */
  day: string;
  /**
   * Where a day change goes. Absent — the real `plan/page.tsx` — it navigates,
   * so the day stays shareable and back-button-correct. A launcher-opened
   * `PlanTab` passes its own `setTabParams` writer instead, because two Plan
   * panes reading one URL meant changing the day in either moved both.
   */
  onDayChange?: (day: string) => void;
}

export function DayPlanner({
  blocks,
  projects,
  areas,
  day,
  onDayChange,
}: DayPlannerProps): React.ReactElement {
  const router = useRouter();
  const refresh = useResparkableRefresh();
  const { state, message, run } = useSaveStatus();

  const [createOpen, setCreateOpen] = React.useState(false);

  const areaNames = new Map(areas.map((area) => [area.id, area.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  const plannedMinutes = blocks.reduce(
    (total, block) => total + minutesBetween(block.startAt, block.endAt),
    0
  );

  async function remove(id: string): Promise<void> {
    const ok = await run(() =>
      apiClient.delete(RESPARKABLE_API.itemPath(RESPARKABLE_API.TIME_BLOCKS, id))
    );
    if (ok) refresh();
  }

  function setDay(next: string): void {
    if (onDayChange) {
      onDayChange(next);
      return;
    }
    router.push(RESPARKABLE_ROUTES.planFor(next));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="plan-day">Day</Label>
          <Input
            id="plan-day"
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="w-44"
          />
        </div>

        <p className="text-muted-foreground pb-2 text-sm">
          {plannedMinutes > 0
            ? `${formatMinutes(plannedMinutes)} blocked out`
            : 'Nothing blocked out yet'}
        </p>
      </div>

      <section className="bg-card flex items-center justify-between gap-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Block out some time
          <FieldHelp title="Why block time">
            <p>
              Blocked time is what makes the ranking know whether a task fits the gap you actually
              have.
            </p>
            <p>
              Without any blocks, every task looks like an average fit. The ranking still works, it
              is just less opinionated.
            </p>
          </FieldHelp>
        </h2>

        <div className="flex items-center gap-2">
          <SaveStatus state={state} message={message} />
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Block out some time
          </Button>
        </div>
      </section>

      <TimeBlockForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        day={day}
        areas={areas}
        projects={projects}
      />

      {blocks.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title="Nothing blocked out"
          description="Block out the time you actually have and the ranking sharpens up: whether a task fits the gap in front of you."
        />
      ) : (
        <ul className="space-y-2">
          {blocks.map((block) => (
            <li
              key={block.id}
              className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <span className="font-medium">{block.title ?? 'Blocked time'}</span>

              <span className="text-muted-foreground text-xs">
                <ClientDate date={block.startAt} showTime /> ·{' '}
                {formatMinutes(minutesBetween(block.startAt, block.endAt))}
              </span>

              {block.areaId && (
                <span className="text-muted-foreground text-xs">
                  {areaNames.get(block.areaId) ?? 'an area'}
                </span>
              )}

              {block.projectId && (
                <span className="text-muted-foreground text-xs">
                  on {projectNames.get(block.projectId) ?? 'a project'}
                </span>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                aria-label={`Remove ${block.title ?? 'this block'}`}
                onClick={() => void remove(block.id)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
}
