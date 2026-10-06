/**
 * "Your membership changed" (§23.13, phase 58): sending it.
 *
 * Sent to the person affected when **somebody else** changes their role,
 * removes them, or approves their request to join. Never for anything the
 * person did themselves, so §23.13's count stays at exactly three emails.
 *
 * Called after the change has committed. A failed send is logged and never
 * surfaced: the change happened whether or not the email arrived, and an
 * error here must not read as the change having failed.
 */

import {
  MembershipChangedEmail,
  membershipChangedSubject,
  type MembershipChange,
} from '@/components/resparkable/emails/membership-changed';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';

export interface MembershipNotice {
  groupId: string;
  groupName: string;
  /** The admin who made the change. */
  actorUserId: string;
  /** The person it was made to, and the one who is emailed. */
  subjectUserId: string;
  change: MembershipChange;
}

/** Email the affected person. Never throws, and never emails anybody about their own act. */
export async function sendMembershipChangedNotice(notice: MembershipNotice): Promise<void> {
  if (notice.actorUserId === notice.subjectUserId) return;

  try {
    // Both read from the person's PERSONAL space key, which is their user id.
    // A legitimate `spaceScope()` mint: neither id came from a request body.
    const [subject, actor] = await Promise.all([
      findOwnerContact(spaceScope(notice.subjectUserId)),
      findOwnerContact(spaceScope(notice.actorUserId)),
    ]);
    if (!subject) return;

    // The admin's name, never their address: a member who was just removed
    // learns who to ask, not how to reach them outside the group (§23.13,
    // and the member lists' "names, never addresses" rule).
    const changedByName = actor?.name ?? 'A group admin';
    const result = await sendEmail({
      to: subject.email,
      // The group's name and nothing in it. See the template's header.
      subject: membershipChangedSubject(notice.groupName, notice.change),
      react: MembershipChangedEmail({
        changedByName,
        groupName: notice.groupName,
        change: notice.change,
      }),
    });
    if (!result.success) {
      logger.warn('Resparkable membership notice not delivered', {
        groupId: notice.groupId,
        kind: notice.change.kind,
      });
    }
  } catch (error) {
    // Ids only: one person's contact details in another person's log is what
    // the deletion notice's comment warns against.
    logger.warn('Resparkable membership notice failed', {
      groupId: notice.groupId,
      kind: notice.change.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
