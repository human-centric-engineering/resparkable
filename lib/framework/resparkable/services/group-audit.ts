/**
 * The group admin record (§23.13, phase 58): writing it, and reading it back.
 *
 * ## Who reads what
 *
 * Admins read every entry. Any other member reads the entries where they are
 * the subject, because the subject of an administrative action has a right to
 * see it. Decided here from the role resolved for this request, never by a
 * repo query shaped by membership (D5).
 *
 * ## The one surface where a name beside an action is right
 *
 * §23.8 forbids counting people's work; it has never protected an
 * administrator from a record of administering. So entries name their actor
 * and subject. What this file still never does is count: no "most active
 * admin", no totals, only the list.
 *
 * ## Atomic where it matters, best effort elsewhere
 *
 * Role changes and removals write their entry in the same transaction as the
 * change (`repo/groups.ts`), because those are the ones a person disputes.
 * The rest call {@link recordGroupAudit} straight after the action: a failed
 * write there is logged and never fails the action it describes.
 */

import { findAccountNames } from '@/lib/framework/resparkable/repo/groups';
import {
  insertGroupAuditEntry,
  listGroupAuditEntries,
  type GroupAuditInput,
} from '@/lib/framework/resparkable/repo/group-audit';
import {
  permissionsFor,
  resolveGroupMembership,
} from '@/lib/framework/resparkable/services/membership';
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

export interface GroupAuditView {
  id: string;
  action: string;
  /** `null` after erasure, or when the system acted. */
  actorName: string | null;
  /** `null` for an action on the group itself, or after erasure. */
  subjectName: string | null;
  /** Whether the reader is the one it was done to. */
  aboutYou: boolean;
  /** Whether the reader is the one who did it. */
  byYou: boolean;
  metadata: unknown;
  createdAt: Date;
}

export type GroupAuditListResult =
  | { ok: true; entries: GroupAuditView[]; scope: 'all' | 'about_you' }
  | { ok: false; reason: 'not_a_member' };

/** The record as this reader may see it. */
export async function listGroupAudit(
  actorUserId: string,
  groupId: string
): Promise<GroupAuditListResult> {
  const resolved = await resolveGroupMembership(actorUserId, groupId);
  if (!resolved) return { ok: false, reason: 'not_a_member' };

  const seesAll = permissionsFor(resolved.scope.role).administer;
  const rows = await listGroupAuditEntries(groupId, seesAll ? {} : { subjectUserId: actorUserId });

  const names = await findAccountNames(
    rows
      .flatMap((row) => [row.actorUserId, row.subjectUserId])
      .filter((id): id is string => id !== null)
  );

  return {
    ok: true,
    scope: seesAll ? 'all' : 'about_you',
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorName: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
      subjectName: row.subjectUserId ? (names.get(row.subjectUserId) ?? null) : null,
      aboutYou: row.subjectUserId === actorUserId,
      byYou: row.actorUserId === actorUserId,
      metadata: row.metadata,
      createdAt: row.createdAt,
    })),
  };
}
