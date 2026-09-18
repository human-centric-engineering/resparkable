import type { Metadata } from 'next';

import { GroupsView } from '@/components/resparkable/groups/groups-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { groupsListSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Groups',
  description: 'Shared workspaces, and who can get into them.',
};

/**
 * Groups — the administrative half of a shared workspace.
 *
 * `null` for the workspace, and not an omission: this list is keyed on the
 * ACTOR. "Which groups am I in" is a question about a person, and asking it
 * from inside one workspace would be circular. It is the same reason the
 * switcher's own list is read with `null` in the layout.
 */
export default async function ResparkableGroupsPage() {
  const result = await readResparkable(RESPARKABLE_API.GROUPS, groupsListSchema, null);

  if (!result.ok) {
    return <LoadError what="your groups" message={result.message} />;
  }

  return <GroupsView initial={result.data} />;
}
