/**
 * Recording one administrative action in a group's admin record, best effort
 * (§23.13, phase 58).
 *
 * Its own module, importing nothing about membership, so the membership
 * service and the other group services share this one copy without an import
 * cycle. Role changes and removals do not come through here: they write their
 * entry in the same transaction as the change (`repo/groups.ts`).
 */

import {
  insertGroupAuditEntry,
  type GroupAuditInput,
} from '@/lib/framework/resparkable/repo/group-audit';
import { logger } from '@/lib/logging';

/** Record an administrative action after it happened. Never throws. */
export async function recordGroupAudit(input: GroupAuditInput): Promise<void> {
  try {
    await insertGroupAuditEntry(input);
  } catch (error) {
    // The action already happened, and refusing it now would be worse than a
    // gap in its record. Ids only, never names or addresses.
    logger.warn('Resparkable group audit entry not written', {
      groupId: input.groupId,
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
