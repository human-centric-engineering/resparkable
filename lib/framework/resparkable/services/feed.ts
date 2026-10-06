/**
 * The group activity feed (§23.10, phase 59): what happened, now, at no cost.
 *
 * One source and two cadences. The digest (§23.8) answers what the period
 * meant and is the only half worth a model call; this answers what happened
 * and reads `ResparkableEvent` on the `[spaceId, createdAt desc]` index it
 * already had. Nothing new is captured.
 *
 * ## The four things it is not
 *
 * 1. Not the Activity pane, which is a decision queue. This is a record.
 * 2. Not push. The client polls with `If-None-Match`, and an unchanged page is
 *    a 304 (see the route).
 * 3. Not an ACL. Every member sees every event in the space. `feedSeenAt`
 *    decides styling, and no query here reads it in a `WHERE`.
 * 4. Not a monitor. Lines are about items, with the person as attribution.
 *    There is no count, total, rate or ranking over members anywhere in this
 *    file, and the member filter returns rows only.
 */

import { findFeedTitles, feedRefKey } from '@/lib/framework/resparkable/repo/feed';
import { listEvents } from '@/lib/framework/resparkable/repo/events';
import {
  findAccountNames,
  findGroupBySpaceId,
  findMembershipBySpace,
  setFeedSeenAt,
} from '@/lib/framework/resparkable/repo/groups';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';

/** One page. Enough to fill a tab; older lines are a scroll away. */
export const FEED_PAGE_SIZE = 50;

export interface FeedItem {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  /** What the line is about, or `null` for an item since deleted. */
  title: string | null;
  /** Who did it, by account name; `null` for a nameless or erased account. */
  actorName: string | null;
  /** Whether the reader did it. */
  byYou: boolean;
  /** A background run: the workspace acted, not a person (§23.10). */
  system: boolean;
  createdAt: Date;
}

export interface FeedPage {
  items: FeedItem[];
  /** Pass as `before` for the next page; `null` when there is no more. */
  nextCursor: string | null;
  /** When the reader last marked the feed read; `null` for never. */
  seenAt: Date | null;
}

export interface FeedQuery {
  before?: Date;
  /** "What did Priya add": rows by one member, and never a count of them. */
  memberUserId?: string;
}

/** The page, or `null` when the space is not a group's (a personal feed is a different feature). */
export async function buildFeed(
  scope: SpaceScope,
  query: FeedQuery = {}
): Promise<FeedPage | null> {
  const group = await findGroupBySpaceId(scope.spaceId);
  if (!group) return null;

  const events = await listEvents(
    scope,
    {
      ...(query.before ? { before: query.before } : {}),
      ...(query.memberUserId ? { actorUserId: query.memberUserId } : {}),
    },
    { take: FEED_PAGE_SIZE + 1 }
  );
  const page = events.slice(0, FEED_PAGE_SIZE);
  const hasMore = events.length > FEED_PAGE_SIZE;

  const [titles, names, membership] = await Promise.all([
    findFeedTitles(scope, page),
    findAccountNames(
      page.map((event) => event.createdByUserId).filter((id): id is string => id !== null)
    ),
    scope.actorUserId ? findMembershipBySpace(scope.actorUserId, scope.spaceId) : null,
  ]);

  const last = page[page.length - 1];
  return {
    items: page.map((event) => ({
      id: event.id,
      kind: event.kind,
      entityType: event.entityType,
      entityId: event.entityId,
      title: titles.get(feedRefKey(event)) ?? null,
      actorName: event.createdByUserId ? (names.get(event.createdByUserId) ?? null) : null,
      byYou: event.createdByUserId !== null && event.createdByUserId === scope.actorUserId,
      system: event.source === 'system',
      createdAt: event.createdAt,
    })),
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    seenAt: membership?.feedSeenAt ?? null,
  };
}

/**
 * Mark the feed read for the reader. Writes their own membership row only,
 * which is why a group viewer may call it (`{ access: 'read' }` at the route).
 */
export async function markFeedSeen(scope: SpaceScope, at: Date = new Date()): Promise<boolean> {
  if (!scope.actorUserId) return false;
  const group = await findGroupBySpaceId(scope.spaceId);
  if (!group) return false;
  await setFeedSeenAt(group.id, scope.actorUserId, at);
  return true;
}
