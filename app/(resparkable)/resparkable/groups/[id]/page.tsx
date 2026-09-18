import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GroupDetail } from '@/components/resparkable/groups/group-detail';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { getServerSession } from '@/lib/auth/utils';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { groupDetailSchema, groupInvitesSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Group',
  description: 'Who is in this group, and who has been invited.',
};

/**
 * One group.
 *
 * ## Two reads, and why that is not the N+1 rule being bent
 *
 * The invitations list is admin-only at the route. Folding it into the detail
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

  const [session, detail] = await Promise.all([
    getServerSession(),
    readResparkable(RESPARKABLE_API.group(id), groupDetailSchema, null),
  ]);

  if (!detail.ok) {
    if (detail.status === 404) notFound();
    return <LoadError what="this group" message={detail.message} />;
  }

  // Only for an admin, because only an admin's request would be answered. A
  // failure here is not a page failure: the group still renders, without the
  // list somebody may not be entitled to anyway.
  const invites =
    detail.data.yourRole === 'admin'
      ? await readResparkable(RESPARKABLE_API.groupInvites(id), groupInvitesSchema, null)
      : null;

  return (
    <GroupDetail
      detail={detail.data}
      invites={invites?.ok ? invites.data : []}
      viewerUserId={session?.user.id ?? ''}
    />
  );
}
