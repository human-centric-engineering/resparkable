/**
 * Review repo — owner-scoped reads and writes over the generated-artefact table.
 *
 * `ResparkableReview` is how something persists an artefact the UI can render: the
 * daily triage summary, the weekly review, the morning briefing. Phase 3 only
 * *read* the latest one, so that `GET /resparkable/today` could show it if it
 * existed and say nothing if it didn't.
 *
 * Phase 6 adds the write path, because `resparkable_write_review` is one of the
 * thirteen capabilities and a capability with nothing to call is not a
 * capability. The workflows that will be its main caller arrive in phase 7; the
 * table and the routes do not have to wait for them, and building them together
 * would have meant the agent layer's only untested write path shipping inside a
 * workflow PR.
 *
 * Reading the briefing rather than generating it on demand is the whole design:
 * the button serves a stored row instantly instead of making somebody wait
 * twenty seconds for an LLM (§6).
 */

import { prisma } from '@/lib/db/client';
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
import type { ResparkableReview, Prisma } from '@prisma/client';

export interface ReviewFilters {
  horizon?: string;
}

export type ReviewCreateData = WithoutOwner<Prisma.ResparkableReviewUncheckedCreateInput>;

function reviewWhere(
  scope: SpaceScope,
  filters: ReviewFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ResparkableReviewWhereInput {
  return {
    ...liveSpaceWhere(scope, includeArchived),
    ...(filters.horizon ? { horizon: filters.horizon } : {}),
  };
}

/** The most recently generated review, optionally of one horizon. */
export async function findLatestReview(
  scope: SpaceScope,
  horizon?: string
): Promise<ResparkableReview | null> {
  return prisma.resparkableReview.findFirst({
    where: { ...liveSpaceWhere(scope), ...(horizon ? { horizon } : {}) },
    orderBy: { generatedAt: 'desc' },
  });
}

export async function listReviews(
  scope: SpaceScope,
  filters: ReviewFilters = {},
  options: ListOptions = {}
): Promise<ResparkableReview[]> {
  return prisma.resparkableReview.findMany({
    where: reviewWhere(scope, filters, options.includeArchived),
    orderBy: { generatedAt: 'desc' },
    ...pageArgs(options),
  });
}

export async function countReviews(
  scope: SpaceScope,
  filters: ReviewFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableReview.count({ where: reviewWhere(scope, filters, includeArchived) });
}

export async function findReview(scope: SpaceScope, id: string): Promise<ResparkableReview | null> {
  return prisma.resparkableReview.findFirst({ where: { ...spaceWhere(scope), id } });
}

export async function createReview(
  scope: SpaceScope,
  data: ReviewCreateData
): Promise<ResparkableReview> {
  return prisma.resparkableReview.create({ data: { ...data, ...spaceWhere(scope) } });
}

export async function archiveReview(
  scope: SpaceScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableReview | null> {
  // No `archiveAndDropVectors` hop: `review` is not one of the six embedded
  // types, so there are no `ResparkableEmbedding` rows to drop. The `indexedHash`
  // column on the model is dormant, carried for the same reason `rev` is.
  return nullOnMiss(() =>
    prisma.resparkableReview.update({
      where: { id, ...spaceWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason },
    })
  );
}

export async function deleteReview(
  scope: SpaceScope,
  id: string
): Promise<ResparkableReview | null> {
  return nullOnMiss(() => prisma.resparkableReview.delete({ where: { id, ...spaceWhere(scope) } }));
}
