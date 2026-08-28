/**
 * Grant repo — the OWNER's side of a named share.
 *
 * Issuing, listing, amending and revoking a grant are all things a person does
 * to their own brain, so they take an `OwnerScope` and live here. Reading the
 * grant table **by grantee** is a shared query — it is the one read that
 * crosses a user — and lives in `access/store.ts`. That split is D5, and it is
 * why nothing in this file takes a viewer.
 *
 * ## Why this file has no `visibility` writes, unlike `share-links.ts`
 *
 * `visibility` on an entity is only ever about the **public-link** surface: it
 * exists so a list can render a "shared" badge without joining to the link
 * table. A named grant is not that surface. An item shared with one named
 * person is not "on the internet" in any sense the column is asked about, and
 * flipping it to `'link'` here would make the badge claim something untrue and
 * would make revoking the last grant a question about links.
 *
 * The owner's "who can see this?" answer therefore comes from
 * {@link listOwnGrants}, which is a join the grant surfaces can afford and the
 * hot path never makes.
 *
 * ## Re-granting is an update
 *
 * `@@unique([entityType, entityId, granteeEmail])` is what makes that true at
 * the database, and {@link upsertGrant} is what makes it true in one round
 * trip. Two live grants to one address on one item would make "what can Bob
 * do?" a question with two answers, which is the shape of every access bug that
 * ends with somebody seeing more than was meant.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';
import { isShareActive } from '@/lib/utils/share-window';
import type { Prisma, ResparkableGrant } from '@prisma/client';

/** Everything a grant is created with, resolved. */
export interface GrantCreateData {
  entityType: ResparkableShareableType;
  entityId: string;
  granteeEmail: string;
  /**
   * Set when the address already has an account, so the grant is usable on the
   * grantee's next request rather than on their acceptance. Null otherwise —
   * `granteeClauses` matches on the address as well, so an unaccepted grant is
   * still live; the invite (phase 13) binds an account to it, it does not
   * create the access.
   */
  granteeUserId: string | null;
  role: 'viewer' | 'commenter';
  includeTaskDetail: boolean;
  expiresAt: Date | null;
}

/** The fields a PATCH may move. `granteeEmail` is deliberately not among them. */
export interface GrantUpdateData {
  role?: 'viewer' | 'commenter';
  includeTaskDetail?: boolean;
  expiresAt?: Date | null;
}

export interface GrantFilters {
  entityType?: ResparkableShareableType;
  entityId?: string;
  includeInactive?: boolean;
}

/**
 * Issue a grant, or amend the one already addressed to that person.
 *
 * The `upsert` targets the unique triple rather than the id, which is what
 * makes "share this with Bob again, as a commenter this time" a single
 * statement with no read-then-write race.
 *
 * **`revokedAt: null` is in the update payload on purpose.** Re-sharing with
 * someone previously revoked reinstates them — the row is the relationship, and
 * leaving a tombstone that silently swallows the new grant would mean the owner
 * pressing "share" and nothing happening. `acceptedAt` is deliberately *not*
 * reset: a person who already bound their account to this row does not have to
 * do it again because the role changed.
 *
 * `userId` is spread from the scope rather than accepted as an argument, so
 * this cannot be called to write into another person's brain.
 */
export async function upsertGrant(
  scope: OwnerScope,
  data: GrantCreateData
): Promise<ResparkableGrant> {
  const shared = {
    role: data.role,
    includeTaskDetail: data.includeTaskDetail,
    expiresAt: data.expiresAt,
  };

  return prisma.resparkableGrant.upsert({
    where: {
      entityType_entityId_granteeEmail: {
        entityType: data.entityType,
        entityId: data.entityId,
        granteeEmail: data.granteeEmail,
      },
    },
    create: {
      ...ownerWhere(scope),
      entityType: data.entityType,
      entityId: data.entityId,
      granteeEmail: data.granteeEmail,
      granteeUserId: data.granteeUserId,
      ...shared,
    },
    update: {
      ...shared,
      revokedAt: null,
      // Only ever fills a null in. An accepted grant already knows who its
      // grantee is, and overwriting that from a fresh account lookup would let
      // a re-registered address inherit somebody else's acceptance.
      ...(data.granteeUserId ? { granteeUserId: data.granteeUserId } : {}),
    },
  });
}

/**
 * The grants this owner has issued.
 *
 * Ordered newest first, like the link list, because the question a person opens
 * this list with is almost always about something they just did.
 *
 * Inactive rows are filtered **in JS through `isShareActive`** rather than by a
 * `where` clause, for the reason `access/store.ts` gives at greater length: one
 * definition of "still live", shared with the link table and with the admin
 * conversation shares, beats two that can drift.
 */
export async function listOwnGrants(
  scope: OwnerScope,
  filters: GrantFilters = {},
  now: Date = new Date()
): Promise<ResparkableGrant[]> {
  const where: Prisma.ResparkableGrantWhereInput = { ...ownerWhere(scope) };
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;

  const rows = await prisma.resparkableGrant.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  if (filters.includeInactive) return rows;
  return rows.filter((row) => isShareActive(row, now));
}

/**
 * One of this owner's grants, by id.
 *
 * `findFirst` with the owner in the `where` rather than `findUnique` by id:
 * another person's grant id must come back as `null`, not as a row the caller
 * then has to remember to check. Not-found and not-yours are the same answer.
 */
export async function findOwnGrant(
  scope: OwnerScope,
  id: string
): Promise<ResparkableGrant | null> {
  return prisma.resparkableGrant.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Amend a live grant.
 *
 * `updateMany` rather than `update`, because the `where` carries `userId` and
 * that is not a unique key — and because a miss must be zero rows rather than a
 * throw. Returns whether anything moved, which the route turns into a 404.
 */
export async function updateGrant(
  scope: OwnerScope,
  id: string,
  data: GrantUpdateData
): Promise<boolean> {
  const result = await prisma.resparkableGrant.updateMany({
    where: { ...ownerWhere(scope), id },
    data,
  });
  return result.count > 0;
}

/**
 * Revoke a grant.
 *
 * A `revokedAt` stamp rather than a delete, so the owner's list can still show
 * what was shared and when it stopped — and so an accidental revoke is
 * answerable with "re-share", which {@link upsertGrant} handles by reinstating
 * the same row.
 *
 * Revocation takes effect on the grantee's **next request**: nothing in the
 * access layer caches beyond one request, so there is no window to close here.
 *
 * Already-revoked rows are excluded from the `where` so a second revoke does
 * not move the timestamp. Re-stamping would rewrite the audit answer to "when
 * did access stop?" every time somebody pressed the button again.
 */
export async function revokeGrant(
  scope: OwnerScope,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await prisma.resparkableGrant.updateMany({
    where: { ...ownerWhere(scope), id, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count > 0;
}

/**
 * How many live grants exist on each of these items, for one owner.
 *
 * The list surfaces' "shared with 2 people" badge. A `groupBy` rather than a
 * count per row, because the alternative on a fifty-card board is fifty
 * queries — the same reasoning that made `resolveResparkableAccessMany` a
 * requirement rather than an optimisation.
 *
 * Expiry is applied in JS for the usual reason, which means the rows have to be
 * read rather than aggregated in SQL. Grants are issued in handfuls, not
 * thousands, so reading them is cheaper than a second definition of "live".
 */
export async function countLiveGrantsByEntity(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();

  const rows = await prisma.resparkableGrant.findMany({
    where: { ...ownerWhere(scope), entityType, entityId: { in: [...entityIds] }, revokedAt: null },
    select: { entityId: true, expiresAt: true, revokedAt: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isShareActive(row, now)) continue;
    counts.set(row.entityId, (counts.get(row.entityId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The account id behind an address, or `null` if there is no account.
 *
 * ## Why this is in the repo layer, and why it takes no scope
 *
 * It reads core's `user` table rather than a `framework_resparkable_*` one, which makes
 * it the second file here to do so — `repo/owner-contact.ts` is the first, and
 * its docblock carries the general argument: the tier's Prisma access is
 * confined to `repo/**` and `access/**` by ESLint, and keeping that rule
 * absolute is worth more than the tidiness of a file that only touches
 * Resparkable models.
 *
 * It takes no `OwnerScope` because it reads no brain rows. `owner-contact.ts`
 * resolves an account id to an address; this resolves an address to an account
 * id. Neither can reach an item, a task or a note, and this one is deliberately
 * narrowed to a single column so it cannot quietly grow into an account-detail
 * lookup for whoever imports it next.
 *
 * ## What the caller must not do with the answer
 *
 * **Never put it in a response.** §13 requires that issuing a grant returns an
 * identical shape whether or not the address has an account: a 201 that
 * differed would turn "share with someone" into an account-existence oracle
 * anyone with a signup form could query. The id belongs on the row, where it
 * makes the grant usable on the grantee's next request, and nowhere else.
 */
export async function findAccountIdForEmail(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });
  return user?.id ?? null;
}
