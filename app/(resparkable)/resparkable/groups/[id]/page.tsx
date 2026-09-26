import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { getServerSession } from '@/lib/auth/utils';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  groupBudgetSchema,
  groupDetailSchema,
  groupInvitesSchema,
  groupJoinLinksSchema,
} from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Group',
  description: 'Who is in this group, and who has been invited.',
};

/**
 * One group.
 *
 * ## Three reads, and why that is not the N+1 rule being bent
 *
 * The invitations and join-link lists are admin-only at their routes. Folding it into the detail
 * payload would mean either refusing the whole page to a member, or a detail
 * endpoint that returns a different shape depending on who asked. Two
 * endpoints keep the permission where the route already enforces it and let a
 * non-admin's page simply not ask.
 *
 * ## `null` for the workspace
 *
 * Keyed on the actor and the group id, like the list. See that page's note.
 *
 * ## A 404 is a 404
 *
 * A group you are not in, a pending membership and a group id somebody invented
 * are one answer from the API, and this page passes that through unchanged. A
 * page that said "you do not have access to this group" would confirm the group
 * exists to whoever guessed the id.
 */
export default async function ResparkableGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // The budget is answered for every member (the per-person half only for an
  // admin, decided by the route), so it is read alongside the detail rather
  // than after it. A failure costs the page its credits section, not the page.
  const [session, detail, budget] = await Promise.all([
    getServerSession(),
    readResparkable(RESPARKABLE_API.group(id), groupDetailSchema, null),
    readResparkable(RESPARKABLE_API.groupBudget(id), groupBudgetSchema, null),
  ]);

  if (!detail.ok) {
    if (detail.status === 404) notFound();
    return <LoadError what="this group" message={detail.message} />;
  }

  // Only for an admin, because only an admin's request would be answered. A
  // failure here is not a page failure: the group still renders, without the
  // list somebody may not be entitled to anyway.
  const isAdmin = detail.data.yourRole === 'admin';
  const [invites, joinLinks] = isAdmin
    ? await Promise.all([
        readResparkable(RESPARKABLE_API.groupInvites(id), groupInvitesSchema, null),
        readResparkable(RESPARKABLE_API.groupJoinLinks(id), groupJoinLinksSchema, null),
      ])
    : [null, null];

  return (
    <GroupDetail
      detail={detail.data}
      invites={invites?.ok ? invites.data : []}
      joinLinks={joinLinks?.ok ? joinLinks.data : []}
      budget={budget.ok ? budget.data : null}
      viewerUserId={session?.user.id ?? ''}
    />
  );
}
