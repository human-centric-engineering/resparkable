'use client';

/**
 * ArchiveTab — the launcher-opened counterpart to `app/(protected)/resparkable/archive/page.tsx`.
 *
 * Six fetches, same as the server page: only the stale digest is
 * load-bearing enough to fail the whole tab, and each of the other five
 * archive sections renders empty with its own message rather than taking
 * the rest down — reproduced here as five independent `useTabFetch` calls
 * rather than one combined request, matching the page's own
 * `Promise.all` exactly.
 */

import * as React from 'react';
import { z } from 'zod';

import { ArchivedList } from '@/components/resparkable/lifecycle/archived-list';
import { StaleDigest } from '@/components/resparkable/lifecycle/stale-digest';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import {
  useTabFetch,
  type TabFetchState,
} from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  entitySchema,
  goalSchema,
  projectSchema,
  staleDigestSchema,
  taskSchema,
  thoughtSchema,
} from '@/lib/framework/resparkable/ui/payloads';

const projectsSchema = z.array(projectSchema);
const goalsSchema = z.array(goalSchema);
const tasksSchema = z.array(taskSchema);
const thoughtsSchema = z.array(thoughtSchema);
const entitiesSchema = z.array(entitySchema);

function archived(collection: string): string {
  return `${collection}?includeArchived=only&limit=100`;
}

/** Projects and entities carry `name`; goals and tasks carry `title`. Same two mappers as the page — kept separate so a schema growing one field and not the other can't quietly render an empty string. */
function fromNamed(row: {
  id: string;
  name: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  return {
    id: row.id,
    title: row.name,
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}

function withTitle(row: {
  id: string;
  title: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  return {
    id: row.id,
    title: row.title,
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}

/** A thought has no title — its content is the thing, truncated to its first line. */
function fromThought(row: {
  id: string;
  content: string;
  archivedAt: string | null;
  archivedReason?: string | null;
}) {
  const firstLine = row.content.split('\n')[0] ?? '';
  return {
    id: row.id,
    title: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine || 'Empty note',
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason ?? null,
  };
}

function items<T, U>(state: TabFetchState<T[]>, map: (row: T) => U): U[] {
  return state.status === 'ready' ? state.data.map(map) : [];
}

export function ArchiveTab(): React.ReactElement {
  const [digest, retryDigest] = useTabFetch(RESPARKABLE_API.STALE, staleDigestSchema);
  const [projects] = useTabFetch(archived(RESPARKABLE_API.PROJECTS), projectsSchema);
  const [goals] = useTabFetch(archived(RESPARKABLE_API.GOALS), goalsSchema);
  const [tasks] = useTabFetch(archived(RESPARKABLE_API.TASKS), tasksSchema);
  const [thoughts] = useTabFetch(archived(RESPARKABLE_API.THOUGHTS), thoughtsSchema);
  const [entities] = useTabFetch(archived(RESPARKABLE_API.ENTITIES), entitiesSchema);

  if (digest.status === 'loading') return <SkeletonList label="Loading archive" />;
  if (digest.status === 'error') {
    return (
      <TabLoadError what="what has gone quiet" message={digest.message} onRetry={retryDigest} />
    );
  }

  return (
    <div className="space-y-10 p-4 md:p-6">
      <section>
        <h2 className="text-lg font-semibold">Gone quiet</h2>
        <p className="text-muted-foreground mt-1 mb-4 text-sm">
          Age is a poor guide to whether something still matters, so these are questions rather than
          decisions. Nothing here is archived unless you say so.
        </p>
        <StaleDigest digest={digest.data} />
      </section>

      <section className="space-y-6">
        <h2 className="text-lg font-semibold">Archived</h2>

        <div>
          <h3 className="mb-2 text-base font-semibold">Projects</h3>
          <ArchivedList
            items={items(projects, fromNamed)}
            collection={RESPARKABLE_API.PROJECTS}
            noun="project"
            emptyLabel={
              projects.status === 'ready'
                ? 'No archived projects.'
                : 'Archived projects could not be loaded.'
            }
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Goals</h3>
          <ArchivedList
            items={items(goals, withTitle)}
            collection={RESPARKABLE_API.GOALS}
            noun="goal"
            emptyLabel={
              goals.status === 'ready'
                ? 'No archived goals.'
                : 'Archived goals could not be loaded.'
            }
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Tasks</h3>
          <ArchivedList
            items={items(tasks, withTitle)}
            collection={RESPARKABLE_API.TASKS}
            noun="task"
            emptyLabel={
              tasks.status === 'ready'
                ? 'No archived tasks.'
                : 'Archived tasks could not be loaded.'
            }
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">Notes</h3>
          <ArchivedList
            items={items(thoughts, fromThought)}
            collection={RESPARKABLE_API.THOUGHTS}
            noun="note"
            emptyLabel={
              thoughts.status === 'ready'
                ? 'No archived notes.'
                : 'Archived notes could not be loaded.'
            }
          />
        </div>

        <div>
          <h3 className="mb-2 text-base font-semibold">People and companies</h3>
          <ArchivedList
            items={items(entities, fromNamed)}
            collection={RESPARKABLE_API.ENTITIES}
            noun="person or company"
            emptyLabel={
              entities.status === 'ready'
                ? 'No archived people or companies.'
                : 'These could not be loaded.'
            }
          />
        </div>
      </section>
    </div>
  );
}
