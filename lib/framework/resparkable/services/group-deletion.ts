/**
 * Deleting a group: the one action in the tier that destroys a workspace other
 * people were writing into.
 *
 * ## The two things §23.6 asks for, and where each one lives
 *
 * 1. **A typed confirmation naming the group.** Checked here, on the server,
 *    and not only in the dialog. A client that skipped the dialog (a script, an
 *    API key, a future UI that forgot) would otherwise be one `DELETE` away
 *    from removing a shared brain. This is the same explicitness §13 demands
 *    for a never-expiring share link, and it is API-first for the reason
 *    everything in this tier is: the rule has to hold for every caller.
 * 2. **A notification to every other member.** They did not do this and they
 *    lose what they added. One email each, sent after the delete commits.
 *
 * ## Why the addresses are read before the delete
 *
 * The delete cascades the memberships, and after it there is nothing left that
 * says who was in the group. So the order is: resolve, check, read who to tell,
 * delete, then send.
 *
 * ## Why sending is reported, never thrown
 *
 * The same rule `issueGroupInvite` follows. The delete has committed by the time
 * the first email goes; a provider outage cannot un-delete a group, and a throw
 * would tell the admin their deletion failed when it did not. The response says
 * how many members were told, and the log line says how many were not.
 *
 * @see lib/framework/resparkable/services/membership.ts: the rest of the
 *      membership rules. Deletion moved out of it in phase 48 so that file does
 *      not import an email template.
 */

import { GroupDeletedEmail } from '@/components/resparkable/emails/group-deleted';
import { deleteGroupSpace, listMemberContacts } from '@/lib/framework/resparkable/repo/groups';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  permissionsFor,
  resolveGroupMembership,
} from '@/lib/framework/resparkable/services/membership';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';

/**
 * Why a deletion was refused.
 *
 * `confirmation_mismatch` is a 400 rather than a 403: the caller is allowed to
 * do this, they just have not said which group they mean.
 */
export type GroupDeletionRefusal = 'not_a_member' | 'not_an_admin' | 'confirmation_mismatch';

export type GroupDeletionResult =
  | { ok: true; notified: number; notifyFailed: number }
  | { ok: false; reason: GroupDeletionRefusal };

/**
 * Does the typed confirmation name this group?
 *
 * Surrounding whitespace is forgiven, since it is invisible in an input and
 * would make an honest attempt fail for no reason the person can see. Case is
 * not: the point of typing the name is to read it, and "study group b" for
 * "Study Group B" is a sign it was not read.
 */
export function confirmationMatches(groupName: string, confirmName: string): boolean {
  return confirmName.trim() === groupName.trim();
}

/**
 * Delete a group and everything in it, then tell every other member. Admin
 * only, and unrecoverable.
 *
 * One `DELETE` of the space row: the group, its memberships, its invitations
 * and all 23 satellites cascade from it (see `deleteGroupSpace`).
 */
export async function deleteGroupConfirmed(
  actorUserId: string,
  groupId: string,
  confirmName: string
): Promise<GroupDeletionResult> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };
  if (!permissionsFor(resolved.scope.role).administer) {
    return { ok: false, reason: 'not_an_admin' };
  }

  const { group } = resolved.membership;
  if (!confirmationMatches(group.name, confirmName)) {
    return { ok: false, reason: 'confirmation_mismatch' };
  }

  // Before the delete. See this file's header: afterwards, nothing says who was in it.
  const recipients = (await listMemberContacts(groupId)).filter(
    (contact) => contact.userId !== actorUserId
  );
  // The actor's own name, read from their PERSONAL space. A legitimate
  // `spaceScope()` mint site: the id is the session's.
  const actor = await findOwnerContact(spaceScope(actorUserId));
  const deletedByName = actor?.name ?? actor?.email ?? 'A group admin';

  await deleteGroupSpace(group.spaceId);
  logger.info('Resparkable group deleted', { groupId });

  const results = await Promise.allSettled(
    recipients.map((recipient) =>
      sendEmail({
        to: recipient.email,
        // The group's name and nothing in it. See the template's header.
        subject: `${group.name} has been deleted`,
        react: GroupDeletedEmail({ deletedByName, groupName: group.name }),
      })
    )
  );

  const notified = results.filter(
    (result) => result.status === 'fulfilled' && result.value.success
  ).length;
  const notifyFailed = results.length - notified;

  if (notifyFailed > 0) {
    // Counts, never addresses: one person's contact details in another
    // person's infrastructure, for the life of the log.
    logger.warn('Resparkable group deletion notice failed to reach some members', {
      groupId,
      notified,
      notifyFailed,
    });
  }

  return { ok: true, notified, notifyFailed };
}
