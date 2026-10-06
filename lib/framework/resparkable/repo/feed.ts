/**
 * Titles for the activity feed (§23.10, phase 59): what each line is about.
 *
 * One query per entity type present on the page, never one per row. Every
 * read is scoped to the space; an item deleted since its event was written is
 * simply absent from the map, and its line renders without a title.
 */

import { prisma } from '@/lib/db/client';
import { spaceWhere, type SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';

export interface FeedRef {
  entityType: string;
  entityId: string;
}

/** `"<entityType>:<entityId>"`, the key the map below is read by. */
export function feedRefKey(ref: FeedRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

const THOUGHT_TITLE_LENGTH = 80;

/** A note has no title, so its line names the note by its opening words. */
function thoughtTitle(content: string): string {
  const firstLine = content.trim().split('\n')[0] ?? '';
  return firstLine.length > THOUGHT_TITLE_LENGTH
    ? `${firstLine.slice(0, THOUGHT_TITLE_LENGTH - 1)}…`
    : firstLine;
}

export async function findFeedTitles(
  scope: SpaceScope,
  refs: readonly FeedRef[]
): Promise<Map<string, string>> {
  const idsByType = new Map<string, string[]>();
  for (const ref of refs) {
    const ids = idsByType.get(ref.entityType) ?? [];
    ids.push(ref.entityId);
    idsByType.set(ref.entityType, ids);
  }

  const where = (ids: string[]) => ({ ...spaceWhere(scope), id: { in: [...new Set(ids)] } });
  const titles = new Map<string, string>();
  const put = (entityType: string, rows: Array<{ id: string; title: string }>): void => {
    for (const row of rows) titles.set(`${entityType}:${row.id}`, row.title);
  };

  await Promise.all(
    [...idsByType.entries()].map(async ([entityType, ids]) => {
      switch (entityType) {
        case 'task':
          put(
            entityType,
            await prisma.resparkableTask.findMany({
              where: where(ids),
              select: { id: true, title: true },
            })
          );
          return;
        case 'goal':
          put(
            entityType,
            await prisma.resparkableGoal.findMany({
              where: where(ids),
              select: { id: true, title: true },
            })
          );
          return;
        case 'review':
          put(
            entityType,
            await prisma.resparkableReview.findMany({
              where: where(ids),
              select: { id: true, title: true },
            })
          );
          return;
        case 'project': {
          const rows = await prisma.resparkableProject.findMany({
            where: where(ids),
            select: { id: true, name: true },
          });
          put(
            entityType,
            rows.map((row) => ({ id: row.id, title: row.name }))
          );
          return;
        }
        case 'area': {
          const rows = await prisma.resparkableArea.findMany({
            where: where(ids),
            select: { id: true, name: true },
          });
          put(
            entityType,
            rows.map((row) => ({ id: row.id, title: row.name }))
          );
          return;
        }
        case 'entity': {
          const rows = await prisma.resparkableEntity.findMany({
            where: where(ids),
            select: { id: true, name: true },
          });
          put(
            entityType,
            rows.map((row) => ({ id: row.id, title: row.name }))
          );
          return;
        }
        case 'board': {
          const rows = await prisma.resparkableBoard.findMany({
            where: where(ids),
            select: { id: true, name: true },
          });
          put(
            entityType,
            rows.map((row) => ({ id: row.id, title: row.name }))
          );
          return;
        }
        case 'thought': {
          const rows = await prisma.resparkableThought.findMany({
            where: where(ids),
            select: { id: true, content: true },
          });
          put(
            entityType,
            rows.map((row) => ({ id: row.id, title: thoughtTitle(row.content) }))
          );
          return;
        }
        default:
          // A type the feed has no title for renders without one.
          return;
      }
    })
  );

  return titles;
}
