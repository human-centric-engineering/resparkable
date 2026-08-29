/**
 * Share-link repo — the OWNER's side of a public link.
 *
 * Minting, listing and revoking are owner queries: they are things a person
 * does to their own brain, so they take an `SpaceScope` and live here. Reading
 * a link **by its token** is a shared query — the caller is a stranger holding
 * a URL — and lives in `access/store.ts`. The split is D5, and it is why this
 * file has no function taking a token.
 *
 * ## `visibility` is maintained here, in the same transaction
 *
 * `visibility` on the entity is only ever about the public-link surface. It
 * exists so a list can render a "shared" badge without joining to this table,
 * and so nothing on the hot path has to. That makes it a **cache**, and a cache
 * updated in a second statement is a cache that goes wrong the first time a
 * request dies between the two — leaving an item badged as shared with no link,
 * or worse, badged private while a live link serves it.
 *
 * So both writes are transactional, and the flip back to `private` is
 * conditional on there being no other live link (`revokeShareLink`).
 */

import { prisma } from '@/lib/db/client';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';
import { spaceWhere, type SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { nullOnMiss } from '@/lib/framework/resparkable/repo/shared';
import { isShareActive } from '@/lib/utils/share-window';
import type { Prisma, ResparkableShareLink } from '@prisma/client';

export interface ShareLinkCreateData {
  entityType: ResparkableShareableType;
  entityId: string;
  tokenHash: string;
  tokenPrefix: string;
  includeChildren: boolean;
  includeTaskDetail: boolean;
  expiresAt: Date | null;
}

export interface ShareLinkFilters {
  entityType?: ResparkableShareableType;
  entityId?: string;
  includeInactive?: boolean;
}

/**
 * Set an entity's `visibility`, inside whatever transaction the caller is in.
 *
 * Takes the transaction client rather than reaching for the top-level one, so
 * the same helper serves both the mint path and the revoke path — the
 * alternative was one delegate switch for un-awaited `PrismaPromise`s and a
 * second, raw-SQL copy for interactive transactions, which is two places for
 * the table list to be wrong.
 *
 * A `switch` rather than a delegate map, for the reason `access/store.ts`
 * gives: the `never` arm makes adding a shareable type without a visibility
 * path a compile error rather than a silently skipped update.
 *
 * `updateMany` rather than `update`: the `where` carries `userId`, which is not
 * a unique key, and a miss must be zero rows rather than a throw. Ownership is
 * already established by {@link ownsEntity} on the mint path and by reading the
 * link row on the revoke path.
 */
async function setVisibility(
  tx: Prisma.TransactionClient,
  scope: SpaceScope,
  entityType: ResparkableShareableType,
  entityId: string,
  visibility: 'private' | 'link'
): Promise<void> {
  const args = { where: { ...spaceWhere(scope), id: entityId }, data: { visibility } };

  switch (entityType) {
    case 'area':
      await tx.resparkableArea.updateMany(args);
      return;
    case 'goal':
      await tx.resparkableGoal.updateMany(args);
      return;
    case 'project':
      await tx.resparkableProject.updateMany(args);
      return;
    case 'review':
      await tx.resparkableReview.updateMany(args);
      return;
    case 'board':
      await tx.resparkableBoard.updateMany(args);
      return;
    case 'task':
      await tx.resparkableTask.updateMany(args);
      return;
    default: {
      const unreachable: never = entityType;
      throw new Error(`setVisibility: no visibility column for "${String(unreachable)}"`);
    }
  }
}

/**
 * Does this owner own this item at all?
 *
 * Called before minting, so a link cannot be issued against a row the caller
 * does not own — or against one that does not exist. `updateMany` above would
 * silently affect zero rows in that case, and a link pointing at nothing would
 * be minted anyway: a token that 404s for its own creator.
 *
 * Deliberately NOT `access/store.ts`'s `findEntityOwner`: that answers "who
 * owns this?", which is a shared query. This answers "is this mine?", which is
 * an owner query, and asking it the owner-scoped way keeps the mint path inside
 * the layer that cannot express a cross-user read.
 */
export async function ownsEntity(
  scope: SpaceScope,
  entityType: ResparkableShareableType,
  entityId: string
): Promise<boolean> {
  const where = { ...spaceWhere(scope), id: entityId };

  switch (entityType) {
    case 'area':
      return (await prisma.resparkableArea.count({ where })) > 0;
    case 'goal':
      return (await prisma.resparkableGoal.count({ where })) > 0;
    case 'project':
      return (await prisma.resparkableProject.count({ where })) > 0;
    case 'review':
      return (await prisma.resparkableReview.count({ where })) > 0;
    case 'board':
      return (await prisma.resparkableBoard.count({ where })) > 0;
    case 'task':
      return (await prisma.resparkableTask.count({ where })) > 0;
    default: {
      const unreachable: never = entityType;
      throw new Error(`ownsEntity: no table for "${String(unreachable)}"`);
    }
  }
}

/**
 * Mint a link row and flip the item to `visibility: 'link'`, atomically.
 *
 * The caller has already generated and hashed the token — this never sees the
 * plaintext, which is what keeps "the digest is the only copy that is stored"
 * a property of the code rather than of somebody's care.
 */
export async function createShareLink(
  scope: SpaceScope,
  data: ShareLinkCreateData
): Promise<ResparkableShareLink> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.resparkableShareLink.create({
      data: { ...data, ...spaceWhere(scope) },
    });
    await setVisibility(tx, scope, data.entityType, data.entityId, 'link');
    return created;
  });
}

/**
 * The owner's own links, newest first.
 *
 * Active-only by default. An expired link is not deleted — the owner may want
 * to see that it lapsed rather than wonder why a URL they shared stopped
 * working — but it is not what "my share links" means, so it takes an opt-in.
 *
 * The active filter runs in JS rather than in SQL so `isShareActive`
 * (`lib/utils/share-window.ts`) stays the single definition of "still live",
 * shared with the admin conversation shares. A `where` clause here would be a
 * second copy that could drift.
 */
export async function listShareLinks(
  scope: SpaceScope,
  filters: ShareLinkFilters = {},
  now: Date = new Date()
): Promise<ResparkableShareLink[]> {
  const rows = await prisma.resparkableShareLink.findMany({
    where: {
      ...spaceWhere(scope),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  return filters.includeInactive ? rows : rows.filter((row) => isShareActive(row, now));
}

/** One of the owner's links, or `null` — never another owner's. */
export async function findShareLink(
  scope: SpaceScope,
  id: string
): Promise<ResparkableShareLink | null> {
  return prisma.resparkableShareLink.findFirst({ where: { ...spaceWhere(scope), id } });
}

/**
 * Revoke a link, and flip the item back to `private` if it was the last one.
 *
 * Both in one transaction, and the count is taken **inside** it: two people
 * revoking the last two links at once would otherwise each see the other's
 * link as still live and neither would flip the badge.
 *
 * Revoking an already-revoked link is idempotent rather than an error — a
 * double-clicked button is not a failure worth reporting, and the second call
 * changes nothing.
 */
export async function revokeShareLink(
  scope: SpaceScope,
  id: string,
  now: Date = new Date()
): Promise<ResparkableShareLink | null> {
  return nullOnMiss(async () =>
    prisma.$transaction(async (tx) => {
      const link = await tx.resparkableShareLink.findFirst({
        where: { ...spaceWhere(scope), id },
      });
      if (!link) return null;

      const revoked = link.revokedAt
        ? link
        : await tx.resparkableShareLink.update({ where: { id }, data: { revokedAt: now } });

      const siblings = await tx.resparkableShareLink.findMany({
        where: {
          ...spaceWhere(scope),
          entityType: link.entityType,
          entityId: link.entityId,
          id: { not: id },
        },
        select: { revokedAt: true, expiresAt: true },
      });

      // Only when nothing else can still serve this item publicly. A badge
      // saying "private" over a live link is the failure worth avoiding here.
      if (!siblings.some((sibling) => isShareActive(sibling, now))) {
        await setVisibility(
          tx,
          scope,
          link.entityType as ResparkableShareableType,
          link.entityId,
          'private'
        );
      }

      return revoked;
    })
  );
}

/**
 * Count a link's view and stamp when. Called from the public reader.
 *
 * Not scoped, and that is the one exception in this file: the reader has no
 * session, and the link id it passes came from a token lookup that already
 * proved the link is live. Deliberately `updateMany` on an id — a miss is zero
 * rows rather than a throw, because a counter must never be able to fail a
 * page render.
 *
 * No IP, no user agent, no per-view row. A reader of a public link is a person
 * with no account here; the least that answers the owner's "is anyone opening
 * this?" is the right amount to keep.
 */
export async function countShareLinkView(linkId: string, now: Date = new Date()): Promise<void> {
  await prisma.resparkableShareLink.updateMany({
    where: { id: linkId },
    data: { viewCount: { increment: 1 }, lastViewedAt: now },
  });
}
