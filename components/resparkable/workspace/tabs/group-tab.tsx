'use client';

/**
 * GroupTab — one group, opened as a tab.
 *
 * Two fetches rather than one, and this is the exception `ui.md`'s
 * one-enriched-fetch rule leaves room for rather than a violation of it. The
 * invitations list is admin-only at the route, so folding it into the detail
 * payload would mean either a 403 for every non-admin opening the tab, or a
 * detail endpoint that silently returns a different shape depending on who
 * asked. Two endpoints keep the permission where it belongs and let a member's
 * tab simply not ask.
 */

import * as React from 'react';

import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { useSession } from '@/lib/auth/client';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { groupDetailSchema, groupInvitesSchema } from '@/lib/framework/resparkable/ui/payloads';

export interface GroupTabProps {
  id: string;
}

export function GroupTab({ id }: GroupTabProps): React.ReactElement {
  // From the cached session rather than a prop or a fourth field on the detail
  // payload. The member list needs to know which row is you, the browser
  // already has the answer, and asking the server again for something it has
  // already told this page would be a request bought with a round trip.
  const { data: session } = useSession();
  const [detail, retry] = useTabFetch(RESPARKABLE_API.group(id), groupDetailSchema);
  const isAdmin = detail.status === 'ready' && detail.data.yourRole === 'admin';
  const [invites] = useTabFetch(
    isAdmin ? RESPARKABLE_API.groupInvites(id) : null,
    groupInvitesSchema
  );

  if (detail.status === 'loading') return <SkeletonList label="Loading this group" />;
  if (detail.status === 'error') {
    return <TabLoadError what="this group" message={detail.message} onRetry={retry} />;
  }

  return (
    <GroupDetail
      detail={detail.data}
      invites={invites.status === 'ready' ? invites.data : []}
      viewerUserId={session?.user.id ?? ''}
    />
  );
}
