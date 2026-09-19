/**
 * Tell a group's only admin what happens to the role if they close their
 * account. One email per membership.
 *
 * ## Why a sweep and not a send at each moment it becomes true
 *
 * A person becomes a group's only admin in five ways: another admin leaves, is
 * removed, is demoted, closes their account, or the stranded-group sweep
 * promotes them. Four of those are request paths and would be easy to hook.
 * The fifth is not: erasure settles groups inside `eraseUser`'s transaction,
 * and an email sent from there goes out even when the erasure then rolls back.
 * One query that finds every sole admin not yet told covers all five, with no
 * send inside a transaction and no path that can forget to call it.
 *
 * The cost is latency. The email arrives within the hour rather than at once,
 * which is fine for a notice about something that only matters the day they
 * close their account. The group page says the same thing immediately.
 *
 * ## When a send fails
 *
 * The flag is set only after a send succeeds, so a failed send is retried on
 * the next pass. `sendEmail` reports success in development without a
 * provider, so this does not retry forever on a laptop.
 */

import { SoleAdminEmail } from '@/components/resparkable/emails/sole-admin';
import {
  listUnnotifiedSoleAdmins,
  markSoleAdminNotified,
} from '@/lib/framework/resparkable/repo/groups';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';

/** Sole admins told per pass. In steady state, rarely more than one or two. */
const SOLE_ADMIN_BATCH = 50;

export interface SoleAdminNoticeResult {
  notified: number;
  notifyFailed: number;
}

/**
 * Email every sole admin who has not been told yet, up to `limit`.
 *
 * Takes no actor: it acts on what the database says, not on a request. Its only
 * caller is the group-succession job in `jobs.ts`.
 */
export async function notifySoleAdmins(
  limit: number = SOLE_ADMIN_BATCH,
  now: Date = new Date()
): Promise<SoleAdminNoticeResult> {
  const result: SoleAdminNoticeResult = { notified: 0, notifyFailed: 0 };

  for (const admin of await listUnnotifiedSoleAdmins(limit)) {
    try {
      const sent = await sendEmail({
        to: admin.email,
        // The group's name and nothing in it. See the template's header.
        subject: `You are the only admin of ${admin.groupName}`,
        react: SoleAdminEmail({
          groupName: admin.groupName,
          viewersCanInheritAdmin: admin.viewersCanInheritAdmin,
          groupUrl: `${env.NEXT_PUBLIC_APP_URL}${RESPARKABLE_ROUTES.group(admin.groupId)}`,
        }),
      });

      if (!sent.success) {
        result.notifyFailed += 1;
        continue;
      }

      await markSoleAdminNotified(admin.memberId, now);
      result.notified += 1;
    } catch (error) {
      result.notifyFailed += 1;
      // The group id and the error, never the address.
      logger.warn('Resparkable sole-admin notice failed for one group', {
        groupId: admin.groupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
