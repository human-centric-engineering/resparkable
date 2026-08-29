/**
 * Thought repo — the capture inbox, and the front door of the whole product.
 *
 * Two things here are load-bearing:
 *
 *   - **`externalId` dedupe.** `@@unique([userId, externalId])` is what makes a
 *     replayed Postmark delivery or a double-tapped iOS Shortcut idempotent.
 *     `captureThought` uses it rather than checking-then-inserting, so two
 *     concurrent deliveries can't both pass the check.
 *   - **Capture must never fail loudly on a duplicate.** A user re-sending a
 *     thought should get their existing row back, not a 409.
 */

import { prisma } from '@/lib/db/client';
import {
  archiveAndDropVectors,
  deleteAndDropVectors,
  embeddingSensitivityUpdateArgs,
} from '@/lib/framework/resparkable/repo/embeddings';
import {
  liveSpaceWhere,
  spaceWhere,
  type SpaceScope,
  type ArchiveVisibility,
} from '@/lib/framework/resparkable/repo/space-scope';
import {
  isUniqueConstraintViolation,
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableThought, Prisma } from '@prisma/client';

export interface ThoughtFilters {
  status?: string;
  source?: string;
  /** Hide thoughts snoozed into the future — they leave the inbox count too. */
  hideSnoozed?: boolean;
  /**
   * Captured before this instant. The exploratory briefing's "resurfaced
   * thought" read (§6): a fragment from months ago that never became anything is
   * the one most worth putting back in front of someone, and it is exactly what
   * a `createdAt desc` list can never reach.
   */
  capturedBefore?: Date;
  /**
   * Drop `sensitivity: 'sensitive'` rows. For scheduled/background reads whose
   * output the person did not directly ask for right now (the daily briefing's
   * resurfaced thought, the description-summariser) — never for GDPR export,
   * which reads every row regardless of classification.
   */
  excludeSensitive?: boolean;
}

export type ThoughtCreateData = WithoutOwner<Prisma.ResparkableThoughtUncheckedCreateInput>;
export type ThoughtUpdateData = WithoutOwner<Prisma.ResparkableThoughtUncheckedUpdateInput>;

function thoughtWhere(
  scope: SpaceScope,
  filters: ThoughtFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ResparkableThoughtWhereInput {
  return {
    ...liveSpaceWhere(scope, includeArchived),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.hideSnoozed
      ? { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }
      : {}),
    ...(filters.capturedBefore ? { createdAt: { lt: filters.capturedBefore } } : {}),
    ...(filters.excludeSensitive ? { sensitivity: { not: 'sensitive' } } : {}),
  };
}

export async function listThoughts(
  scope: SpaceScope,
  filters: ThoughtFilters = {},
  options: ListOptions = {}
): Promise<ResparkableThought[]> {
  return prisma.resparkableThought.findMany({
    where: thoughtWhere(scope, filters, options.includeArchived),
    orderBy: { createdAt: 'desc' },
    ...pageArgs(options),
  });
}

export async function countThoughts(
  scope: SpaceScope,
  filters: ThoughtFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableThought.count({ where: thoughtWhere(scope, filters, includeArchived) });
}

export async function findThought(
  scope: SpaceScope,
  id: string
): Promise<ResparkableThought | null> {
  return prisma.resparkableThought.findFirst({ where: { ...spaceWhere(scope), id } });
}

export async function createThought(
  scope: SpaceScope,
  data: ThoughtCreateData
): Promise<ResparkableThought> {
  return prisma.resparkableThought.create({ data: { ...data, ...spaceWhere(scope) } });
}

/** Batch lookup, for hydrating a set of thought ids from a link walk (context-digest.ts). */
export async function findThoughtsByIds(
  scope: SpaceScope,
  ids: string[],
  options: { excludeSensitive?: boolean } = {}
): Promise<ResparkableThought[]> {
  if (ids.length === 0) return [];

  return prisma.resparkableThought.findMany({
    where: {
      ...spaceWhere(scope),
      id: { in: ids },
      ...(options.excludeSensitive ? { sensitivity: { not: 'sensitive' } } : {}),
    },
  });
}

/**
 * Idempotent capture. With an `externalId`, a replay returns the row that was
 * already stored instead of creating a second one or throwing — the unique
 * index does the work, so concurrent deliveries resolve correctly.
 */
export async function captureThought(
  scope: SpaceScope,
  data: ThoughtCreateData
): Promise<{ thought: ResparkableThought; deduped: boolean }> {
  try {
    return { thought: await createThought(scope, data), deduped: false };
  } catch (error) {
    if (data.externalId && isUniqueConstraintViolation(error)) {
      const existing = await prisma.resparkableThought.findFirst({
        where: { ...spaceWhere(scope), externalId: data.externalId },
      });
      if (existing) return { thought: existing, deduped: true };
    }
    throw error;
  }
}

export async function updateThought(
  scope: SpaceScope,
  id: string,
  data: ThoughtUpdateData
): Promise<ResparkableThought | null> {
  const update = () =>
    prisma.resparkableThought.update({
      where: { id, ...spaceWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    });

  // Reclassifying is the one edit the hash gate cannot carry (phase 9e).
  // `sensitivity` is deliberately not semantic content, so nulling `indexedHash`
  // above queues a comparison that will match and skip the chunk rewrite — the
  // new classification would reach the vector layer never. So it is pushed onto
  // the chunks here, in the same transaction as the row itself: a privacy
  // control has to be true the moment it is set, not at 03:00 tomorrow.
  const sensitivity = plainSensitivity(data.sensitivity);
  if (sensitivity === undefined) return nullOnMiss(update);

  return nullOnMiss(async () => {
    const [updated] = await prisma.$transaction([
      update(),
      prisma.resparkableEmbedding.updateMany(
        embeddingSensitivityUpdateArgs(scope, 'thought', id, sensitivity)
      ),
    ]);
    return updated;
  });
}

/**
 * The literal behind a Prisma update field, or `undefined` if it isn't one.
 *
 * `UncheckedUpdateInput` lets a caller write either `'sensitive'` or
 * `{ set: 'sensitive' }`, and every caller in the tier writes the first — but
 * the type permits the second, and a denormalisation that silently skipped it
 * would leave the chunks disagreeing with the row they came from. Anything
 * neither shape (nothing produces one today) returns `undefined`, which skips
 * the sync rather than writing a guess.
 */
function plainSensitivity(value: ThoughtUpdateData['sensitivity']): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.set === 'string') return value.set;
  return undefined;
}

export async function archiveThought(
  scope: SpaceScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableThought | null> {
  return archiveAndDropVectors(scope, 'thought', id, () =>
    prisma.resparkableThought.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreThought(
  scope: SpaceScope,
  id: string
): Promise<ResparkableThought | null> {
  return nullOnMiss(() =>
    prisma.resparkableThought.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteThought(
  scope: SpaceScope,
  id: string
): Promise<ResparkableThought | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'thought', id, () =>
    prisma.resparkableThought.delete({ where: { id, ...spaceWhere(scope) } })
  );
}
