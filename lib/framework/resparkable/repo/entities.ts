/**
 * Entity repo — people, companies and market segments.
 *
 * First-class nodes, not areas. An area is a domain of your life with a weekly
 * time target that the scorer deliberately rebalances toward; a client is not
 * that, and balancing attention across customers the way you balance Health
 * against Career would corrupt the ranking. **Entities are absent from
 * `score.ts` entirely** — a neglected client surfaces through the stale digest
 * (§11), never by inflating task scores (§1).
 *
 * They connect to projects and documents through `ResparkableLink`, not FK columns:
 * a project can serve several clients, and an `entityId` column would force a
 * primary-client fiction (D2).
 */

import { prisma } from '@/lib/db/client';
import {
  archiveAndDropVectors,
  deleteAndDropVectors,
} from '@/lib/framework/resparkable/repo/embeddings';
import {
  liveSpaceWhere,
  spaceWhere,
  type SpaceScope,
  type ArchiveVisibility,
} from '@/lib/framework/resparkable/repo/space-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableEntity, Prisma } from '@prisma/client';

export interface EntityFilters {
  kind?: string;
  status?: string;
}

export type EntityCreateData = WithoutOwner<Prisma.ResparkableEntityUncheckedCreateInput>;
export type EntityUpdateData = WithoutOwner<Prisma.ResparkableEntityUncheckedUpdateInput>;

function entityWhere(
  scope: SpaceScope,
  filters: EntityFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ResparkableEntityWhereInput {
  return {
    ...liveSpaceWhere(scope, includeArchived),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export async function listEntities(
  scope: SpaceScope,
  filters: EntityFilters = {},
  options: ListOptions = {}
): Promise<ResparkableEntity[]> {
  return prisma.resparkableEntity.findMany({
    where: entityWhere(scope, filters, options.includeArchived),
    orderBy: [{ lastActivityAt: 'desc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countEntities(
  scope: SpaceScope,
  filters: EntityFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableEntity.count({ where: entityWhere(scope, filters, includeArchived) });
}

export async function findEntity(scope: SpaceScope, id: string): Promise<ResparkableEntity | null> {
  return prisma.resparkableEntity.findFirst({ where: { ...spaceWhere(scope), id } });
}

export async function findEntityBySlug(
  scope: SpaceScope,
  slug: string
): Promise<ResparkableEntity | null> {
  return prisma.resparkableEntity.findFirst({ where: { ...spaceWhere(scope), slug } });
}

export async function createEntity(
  scope: SpaceScope,
  data: EntityCreateData
): Promise<ResparkableEntity> {
  return prisma.resparkableEntity.create({ data: { ...data, ...spaceWhere(scope) } });
}

export async function updateEntity(
  scope: SpaceScope,
  id: string,
  data: EntityUpdateData
): Promise<ResparkableEntity | null> {
  return nullOnMiss(() =>
    prisma.resparkableEntity.update({
      where: { id, ...spaceWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

/**
 * Entities are **never auto-archived** — a dormant client is not a dead one, so
 * retention only flags them in the stale digest and a human decides (§11). This
 * is the manual path.
 */
export async function archiveEntity(
  scope: SpaceScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableEntity | null> {
  return archiveAndDropVectors(scope, 'entity', id, () =>
    prisma.resparkableEntity.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreEntity(
  scope: SpaceScope,
  id: string
): Promise<ResparkableEntity | null> {
  return nullOnMiss(() =>
    prisma.resparkableEntity.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteEntity(
  scope: SpaceScope,
  id: string
): Promise<ResparkableEntity | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'entity', id, () =>
    prisma.resparkableEntity.delete({ where: { id, ...spaceWhere(scope) } })
  );
}
