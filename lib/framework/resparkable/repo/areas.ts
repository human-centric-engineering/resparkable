/**
 * Area repo — owner-scoped reads and writes over `framework_resparkable_area`.
 *
 * Areas are life domains with a weekly time target, and that target is what
 * makes this a life organiser rather than a task list: `areaBalance` floats a
 * neglected area above a hot work project (§10). Clients and companies are
 * `ResparkableEntity`, deliberately not areas — overloading these would corrupt the
 * scorer.
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
import type { ResparkableArea, Prisma } from '@prisma/client';

export type AreaCreateData = WithoutOwner<Prisma.ResparkableAreaUncheckedCreateInput>;
export type AreaUpdateData = WithoutOwner<Prisma.ResparkableAreaUncheckedUpdateInput>;

export async function listAreas(
  scope: SpaceScope,
  options: ListOptions = {}
): Promise<ResparkableArea[]> {
  return prisma.resparkableArea.findMany({
    where: liveSpaceWhere(scope, options.includeArchived),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countAreas(
  scope: SpaceScope,
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableArea.count({ where: liveSpaceWhere(scope, includeArchived) });
}

export async function findArea(scope: SpaceScope, id: string): Promise<ResparkableArea | null> {
  return prisma.resparkableArea.findFirst({ where: { ...spaceWhere(scope), id } });
}

/** Batched lookup for the scorer's project → area walk. See `findProjectsByIds`. */
export async function findAreasByIds(scope: SpaceScope, ids: string[]): Promise<ResparkableArea[]> {
  if (ids.length === 0) return [];

  return prisma.resparkableArea.findMany({ where: { ...spaceWhere(scope), id: { in: ids } } });
}

export async function findAreaBySlug(
  scope: SpaceScope,
  slug: string
): Promise<ResparkableArea | null> {
  return prisma.resparkableArea.findFirst({ where: { ...spaceWhere(scope), slug } });
}

export async function createArea(
  scope: SpaceScope,
  data: AreaCreateData
): Promise<ResparkableArea> {
  return prisma.resparkableArea.create({ data: { ...data, ...spaceWhere(scope) } });
}

export async function updateArea(
  scope: SpaceScope,
  id: string,
  data: AreaUpdateData
): Promise<ResparkableArea | null> {
  return nullOnMiss(() =>
    prisma.resparkableArea.update({
      where: { id, ...spaceWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveArea(
  scope: SpaceScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableArea | null> {
  return archiveAndDropVectors(scope, 'area', id, () =>
    prisma.resparkableArea.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreArea(scope: SpaceScope, id: string): Promise<ResparkableArea | null> {
  return nullOnMiss(() =>
    prisma.resparkableArea.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteArea(scope: SpaceScope, id: string): Promise<ResparkableArea | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'area', id, () =>
    prisma.resparkableArea.delete({ where: { id, ...spaceWhere(scope) } })
  );
}
