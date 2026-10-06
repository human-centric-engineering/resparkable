/**
 * The group admin record (§23.13, phase 58): `ResparkableGroupAuditEntry`.
 *
 * Append-only. This file inserts and lists, and nothing in the tier updates or
 * deletes a row; the only way an entry goes is with its group (cascade).
 *
 * Who may read which entries is decided by the service from the reader's role,
 * never by a `WHERE` shaped by membership here. `subjectUserId` below is a
 * filter the service chooses for a non-admin ("what was done to me"), not an
 * access rule this file enforces.
 *
 * @see lib/framework/resparkable/services/group-audit.ts
 */

import { prisma } from '@/lib/db/client';
import type { GroupDb } from '@/lib/framework/resparkable/repo/groups';
import type { Prisma, ResparkableGroupAuditEntry } from '@prisma/client';

/** The vocabulary. The schema comment on the model carries the same list. */
export const GROUP_AUDIT_ACTIONS = [
  'role_changed',
  'member_removed',
  'member_left',
  'settings_changed',
  'join_link_minted',
  'join_link_revoked',
  'join_approved',
  'join_rejected',
  'invite_issued',
  'invite_revoked',
  'budget_changed',
  'member_cap_changed',
  'topped_up',
] as const;

export type GroupAuditAction = (typeof GROUP_AUDIT_ACTIONS)[number];

export interface GroupAuditInput {
  groupId: string;
  /** Who acted. `null` for an action the system took. */
  actorUserId: string | null;
  /** Who it landed on, when it landed on a person. */
  subjectUserId?: string | null;
  action: GroupAuditAction;
  /** The action's own shape (`{ from, to }` for a role). Never brain content. */
  metadata?: Prisma.InputJsonValue;
}

export async function insertGroupAuditEntry(
  input: GroupAuditInput,
  db: GroupDb = prisma
): Promise<void> {
  await db.resparkableGroupAuditEntry.create({
    data: {
      groupId: input.groupId,
      actorUserId: input.actorUserId,
      subjectUserId: input.subjectUserId ?? null,
      action: input.action,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  });
}

export interface ListGroupAuditOptions {
  /** Only entries about this person. The service sets it for a non-admin. */
  subjectUserId?: string;
  take?: number;
}

/** Newest first, on `[groupId, createdAt desc]`. */
export async function listGroupAuditEntries(
  groupId: string,
  options: ListGroupAuditOptions = {}
): Promise<ResparkableGroupAuditEntry[]> {
  return prisma.resparkableGroupAuditEntry.findMany({
    where: {
      groupId,
      ...(options.subjectUserId !== undefined ? { subjectUserId: options.subjectUserId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: options.take ?? 100,
  });
}
