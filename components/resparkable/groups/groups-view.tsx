'use client';

/**
 * Your groups: the ones you are in, and the form that starts a new one.
 *
 * ## What this page is not
 *
 * It is not where you work in a group. Opening a group's brain is a workspace
 * switch, which lives in the header and keeps you on whatever page you were
 * already looking at. This page is the administrative half: who is in a group,
 * who has been invited, and how to leave. The "Open" link is a convenience that
 * does the same switch, landing on Today.
 *
 * That separation is why the section sits under Manage rather than Organise. A
 * place you visit occasionally and on purpose.
 *
 * ## Not on the space-carrying client
 *
 * Every route here is keyed on the ACTOR rather than on a workspace: "which
 * groups am I in", "who is in this one". They ignore `?space=` outright, so
 * `apiClient` says what is true where `resparkableApi` would append a param the
 * server does not read and imply a relationship that is not there.
 */

import * as React from 'react';
import { Plus, UsersRound } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { WorkspaceLink } from '@/components/resparkable/workspace/workspace-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupListItemWire } from '@/lib/framework/resparkable/ui/payloads';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { withSpace } from '@/lib/framework/resparkable/ui/active-space';

export interface GroupsViewProps {
  initial: GroupListItemWire[];
}

/** What `POST /resparkable/groups` returns, which is less than a list row. */
interface CreatedGroup {
  groupId: string;
  name: string;
  slug: string;
  spaceId: string;
  role: string;
}

export function GroupsView({ initial }: GroupsViewProps): React.ReactElement {
  const [groups, setGroups] = React.useState(initial);
  const [name, setName] = React.useState('');
  const { state, message, run } = useSaveStatus();

  // Server-rendered lists go stale when this component creates a row. Held in
  // state and appended to rather than refetched: the POST already returns the
  // created group, and a refetch would be a second round trip to learn what we
  // were just told.
  React.useEffect(() => setGroups(initial), [initial]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    // `run` reports whether it worked rather than handing the value back, so
    // the created group is caught in a box on the way past. Refetching the list
    // instead would be a second round trip to learn what the POST just said.
    const box: { created: CreatedGroup | null } = { created: null };
    const ok = await run(async () => {
      box.created = await apiClient.post<CreatedGroup>(RESPARKABLE_API.GROUPS, {
        body: { name: trimmed },
      });
    });

    const created = box.created;
    if (ok && created) {
      setName('');
      setGroups((prev) => [
        ...prev,
        { ...created, description: null, joinedAt: new Date().toISOString() },
      ]);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-2" onSubmit={(event) => void create(event)}>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="text-muted-foreground mb-1 block text-xs" htmlFor="new-group-name">
              Start a group
            </label>
            <Input
              id="new-group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Study Group B"
              maxLength={120}
            />
          </div>
          <Button type="submit" size="sm" disabled={!name.trim() || state === 'saving'}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Create
          </Button>
        </div>
        {/* Said here rather than after the fact: a group workspace starts empty
            and separate, and somebody expecting their own projects to appear in
            it should find that out before they invite four people. */}
        <p className="text-muted-foreground text-[11px]">
          A group gets its own workspace, empty to start with. Nothing from yours moves into it.
        </p>
        <SaveStatus
          state={state}
          message={message ?? (state === 'saved' ? 'Group created' : null)}
        />
      </form>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          You are not in any groups yet. Start one above, or open an invitation somebody sent you.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => (
            <li
              key={group.groupId}
              className="border-border/60 flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <UsersRound className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span className="truncate text-sm font-medium">{group.name}</span>
                  <span className="text-muted-foreground text-[11px] capitalize">{group.role}</span>
                  {group.joinedAt === null && (
                    // §23.11: a request to join an admin has not approved. Shown
                    // rather than hidden, because somebody who asked should be
                    // able to see that they asked.
                    <span className="text-muted-foreground text-[11px]">
                      · waiting to be let in
                    </span>
                  )}
                </div>
                {group.description && (
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {group.description}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {group.joinedAt !== null && (
                  // A real link to the same page with a different workspace,
                  // which is all a switch is. `external` because it changes the
                  // workspace rather than opening a tab in this one: opening it
                  // as a tab would put a group's Today inside the personal
                  // workspace's pane tree, which is the confusion the whole
                  // URL-carries-the-space design exists to avoid.
                  <Button asChild variant="outline" size="sm">
                    <a href={withSpace(RESPARKABLE_ROUTES.TODAY, group.spaceId)}>Open</a>
                  </Button>
                )}
                <Button asChild variant="ghost" size="sm">
                  <WorkspaceLink href={RESPARKABLE_ROUTES.group(group.groupId)}>
                    Manage
                  </WorkspaceLink>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
