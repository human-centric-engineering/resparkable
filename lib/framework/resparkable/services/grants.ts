/**
 * Named grants — the owner's side of "share this with a person".
 *
 * The sibling of `services/sharing.ts`, which owns the other kind of share.
 * The product line between them is the one §13 draws and this whole layer is
 * arranged around: **a public link is a document, a named grant is a
 * relationship.** A stranger holding a URL gets the content and nothing about
 * the person; someone the owner named gets to know who shared it, and (with
 * `role: 'commenter'`, phase 13) to say something back.
 *
 * Three things live here rather than in a route.
 *
 * ## 1. The account lookup, and what must never be done with its answer
 *
 * A grant is addressed to an **email**, not to an account. If that address
 * already has one, `granteeUserId` is filled in at once so the grant works on
 * the grantee's very next request rather than waiting for an acceptance they
 * may never perform — `granteeClauses` in `access/store.ts` matches on the
 * address as well, so the access is live either way, but the id is what
 * survives the person changing their address later.
 *
 * **The response must not say which happened.** §13 is explicit: identical
 * shape whether or not the account exists. A 201 that differed — a field, a
 * status word, even a different latency profile worth measuring — would turn
 * "share with someone" into an account-existence oracle that anybody with a
 * signup form could query one address at a time. So {@link GrantSummary} has no
 * `granteeUserId` and no `hasAccount`, and `accepted` is driven by `acceptedAt`,
 * which only a real acceptance sets.
 *
 * ## 2. Ownership is checked before the grant is written, not after
 *
 * `ownsEntity` is the same guard the mint path uses, and for the same reason: a
 * grant issued against a row the caller does not own would be a live grant
 * pointing at nothing, addressed to a real person who would see a 404 they
 * could not explain.
 *
 * ## 3. Reading a granted item is NOT here
 *
 * That is a shared query — the caller is not the owner — and it lives in
 * `services/shared-with-me.ts`. Everything in this file takes an `OwnerScope`
 * and answers a question about the owner's own brain.
 */

import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  findAccountIdForEmail,
  findOwnGrant,
  listOwnGrants as listOwnGrantRows,
  revokeGrant as revokeGrantRow,
  updateGrant as updateGrantRow,
  upsertGrant,
  type GrantFilters,
} from '@/lib/framework/resparkable/repo/grants';
import { ownsEntity } from '@/lib/framework/resparkable/repo/share-links';
import type { CreateGrantInput, UpdateGrantInput } from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import { isShareActive } from '@/lib/utils/share-window';
import type { ResparkableGrant } from '@prisma/client';

/**
 * The default and maximum expiry for a named grant.
 *
 * Ninety days rather than the link surface's thirty. The two are deliberately
 * different numbers: a link is usually issued for one conversation and should
 * stop working after it, whereas a grant is issued to a colleague for the
 * duration of a piece of work, and a quarter is roughly how long that is. The
 * ceiling is the same year, for the same reason — a standing credential to
 * another person's thinking that outlives the reason it was issued is the shape
 * of the problem, whichever surface it arrived on.
 */
export const GRANT_DEFAULT_DAYS = 90;
export const GRANT_MAX_DAYS = 365;

function resolveExpiry(expiry: CreateGrantInput['expiry'], now: Date): Date | null {
  if (expiry.kind === 'never') return null;
  return new Date(now.getTime() + expiry.days * 24 * 60 * 60 * 1000);
}

/**
 * A grant as the **owner** sees it.
 *
 * `granteeEmail` is present because the owner typed it: it is their own record
 * of who they shared with, and masking it here would make the list unusable for
 * the one person entitled to read it. `granteeUserId` is absent for the reason
 * in this file's header, and `inviteTokenHash` is absent because a digest in a
 * response is a digest in a browser's memory, a client store and a screenshot.
 */
export interface GrantSummary {
  id: string;
  entityType: string;
  entityId: string;
  granteeEmail: string;
  role: string;
  includeTaskDetail: boolean;
  /**
   * Whether the grantee has bound an account to this grant.
   *
   * **Not the same question as "can they see it yet"** — they can, from the
   * moment it is issued, because the address matches. This says whether they
   * have been through the invite flow, which is what lets the owner tell a
   * grant somebody has engaged with from one still sitting in a mailbox.
   */
  accepted: boolean;
  invitedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
  createdAt: Date;
}

export function toGrantSummary(grant: ResparkableGrant, now: Date = new Date()): GrantSummary {
  return {
    id: grant.id,
    entityType: grant.entityType,
    entityId: grant.entityId,
    granteeEmail: grant.granteeEmail,
    role: grant.role,
    includeTaskDetail: grant.includeTaskDetail,
    accepted: grant.acceptedAt !== null,
    invitedAt: grant.inviteSentAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    active: isShareActive(grant, now),
    createdAt: grant.createdAt,
  };
}

/**
 * Issue a grant, or amend the one already addressed to that person.
 *
 * Returns `null` when the item is not the owner's or does not exist — the same
 * answer the mint path gives, and the same 404 at the route, because a 403
 * would confirm the row exists to someone who guessed an id.
 *
 * Sending the invite email is **not** done here. It is phase 13, and keeping it
 * out means the grant is a database fact before it is a message: an email that
 * fails to send leaves a working grant rather than a person who was told they
 * had access and does not.
 */
export async function issueGrant(
  scope: OwnerScope,
  input: CreateGrantInput,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  if (!(await ownsEntity(scope, input.entityType, input.entityId))) return null;

  const granteeUserId = await findAccountIdForEmail(input.granteeEmail);

  const grant = await upsertGrant(scope, {
    entityType: input.entityType,
    entityId: input.entityId,
    granteeEmail: input.granteeEmail,
    granteeUserId,
    role: input.role,
    includeTaskDetail: input.includeTaskDetail,
    expiresAt: resolveExpiry(input.expiry, now),
  });

  // No address, and no `hasAccount`. The log is read by operators who are not
  // the owner, and a grantee's email in it is one person's contact details
  // sitting in another person's infrastructure for the life of the log.
  logger.info('Resparkable grant issued', {
    entityType: grant.entityType,
    role: grant.role,
    includeTaskDetail: grant.includeTaskDetail,
    expires: grant.expiresAt !== null,
  });

  return toGrantSummary(grant, now);
}

/** Every grant this owner has issued, newest first. */
export async function listOwnGrants(
  scope: OwnerScope,
  filters: GrantFilters = {},
  now: Date = new Date()
): Promise<GrantSummary[]> {
  const rows = await listOwnGrantRows(scope, filters, now);
  return rows.map((row) => toGrantSummary(row, now));
}

/**
 * Amend a grant's role, detail flag or expiry.
 *
 * Returns `null` for a grant that is not this owner's, which the route turns
 * into a 404. The read-back is a second query and worth it: the client needs
 * the resulting row to render, and computing it from the request would mean
 * guessing at whatever the database actually stored.
 */
export async function updateGrant(
  scope: OwnerScope,
  id: string,
  input: UpdateGrantInput,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  const moved = await updateGrantRow(scope, id, {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.includeTaskDetail !== undefined
      ? { includeTaskDetail: input.includeTaskDetail }
      : {}),
    ...(input.expiry !== undefined ? { expiresAt: resolveExpiry(input.expiry, now) } : {}),
  });
  if (!moved) return null;

  const grant = await findOwnGrant(scope, id);
  if (!grant) return null;

  logger.info('Resparkable grant updated', { entityType: grant.entityType, role: grant.role });

  return toGrantSummary(grant, now);
}

/**
 * Revoke a grant.
 *
 * Takes effect on the grantee's **next request** — nothing in the access layer
 * caches beyond one request, which is the property that makes this sentence
 * true rather than aspirational (§16.3).
 *
 * Returns `null` for a grant that is not this owner's **or is already revoked**,
 * so a double-press is a 404 rather than a second timestamp. The audit answer to
 * "when did access stop?" should not move because somebody clicked twice.
 */
export async function revokeGrant(
  scope: OwnerScope,
  id: string,
  now: Date = new Date()
): Promise<GrantSummary | null> {
  const revoked = await revokeGrantRow(scope, id, now);
  if (!revoked) return null;

  const grant = await findOwnGrant(scope, id);
  if (!grant) return null;

  logger.info('Resparkable grant revoked', { entityType: grant.entityType });

  return toGrantSummary(grant, now);
}
