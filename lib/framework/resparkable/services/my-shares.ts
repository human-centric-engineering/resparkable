/**
 * "Things I have shared": the owner's outbound shares, in one place.
 *
 * ## The gap this closes
 *
 * Release 2 made every share revocable through `ShareDialog`, and `ShareDialog`
 * is only ever reachable **through the entity's own control**. That is fine
 * while the entity is on screen and quietly broken the moment it is not. Three
 * ways it stops being reachable, none of them exotic:
 *
 *   • **It was replaced.** `createReview` is a `create`, never an update, so
 *     tomorrow's briefing card renders a different row. A link minted on
 *     today's briefing pointed at a row with no surface at all, which is why
 *     `review` shipped with no share button.
 *   • **It was archived.** The ordinary end of a project's life. Archiving does
 *     not revoke anything: the grants and the links stay live, and the control
 *     that could close them is now behind a filter most surfaces default to
 *     hiding.
 *   • **It was deleted.** The share rows cascade with the entity, so this one
 *     resolves itself. It is listed because the *title* does not: a share whose
 *     entity is gone must still render as a row here rather than vanish, or the
 *     list quietly disagrees with the database.
 *
 * Granting is not the hard half of sharing. Being able to take it back is, and
 * a share nobody can revoke is not a share, it is a publication. So this is an
 * **inventory keyed on the share rather than on the entity**, which is the only
 * ordering that can show a share whose entity you can no longer navigate to.
 *
 * ## It is an owner query, and it does not touch the access layer
 *
 * D5 splits every brain query into an owner query or a shared query. This is
 * emphatically the first: it asks what *this owner* has given away, every row
 * it reads is `WHERE userId = $1`, and no viewer, grant resolution or basis is
 * involved. `access/*` is not imported and must not be. The similarity to
 * `/shared-with-me` is superficial and worth naming so nobody unifies them:
 * that one reads other people's rows through a grant, this one reads the
 * owner's own rows and the grants they issued.
 *
 * ## Eight queries, whatever the row count
 *
 * Two list queries, then **at most one per shareable type** to resolve titles
 * (six types, so eight in the worst case and fewer in practice). Deliberately
 * not one per share: that is the N+1 `CLAUDE.md` forbids on list endpoints, and
 * it is the shape this would naturally take if the titles were fetched where
 * they are rendered.
 *
 * `findSharedItems` does the resolving. Reusing the reader's projection rather
 * than writing a second one is not only thrift: it is an allowlist, so a column
 * added to `ResparkableProject` next month does not silently start appearing in
 * a list whose job is to name things, and the six-way `switch` already fails
 * the build when a seventh shareable type arrives.
 */

import { listOwnGrants, type GrantSummary } from '@/lib/framework/resparkable/services/grants';
import {
  listOwnShareLinks,
  type PublicShareLinkSummary,
} from '@/lib/framework/resparkable/services/sharing';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findSharedItems } from '@/lib/framework/resparkable/repo/shared-view';
import {
  isResparkableShareableType,
  RESPARKABLE_SHAREABLE_TYPES,
  type ResparkableShareableType,
} from '@/lib/framework/resparkable/validations';

/** One shared thing, with everything the owner has given away on it. */
export interface MyShareItem {
  entityType: ResparkableShareableType;
  entityId: string;
  /**
   * `null` when the entity no longer exists.
   *
   * Rendered rather than filtered out. A share row outliving its entity by a
   * moment is normal (the cascade is a database action, not an instant), and a
   * list that dropped those rows would be answering "what have I shared?" with
   * something other than what the database holds. The UI says "no longer
   * exists" and still offers the revoke, which costs nothing and is correct if
   * the row is somehow still there.
   */
  title: string | null;
  /** Archived entities keep their shares. That is the surprise this surfaces. */
  archived: boolean;
  grants: GrantSummary[];
  links: PublicShareLinkSummary[];
}

export interface MySharesFilters {
  /** Include revoked and expired shares. Off by default. */
  includeInactive?: boolean;
}

/**
 * Every entity this owner has shared, with its grants and its links.
 *
 * Ordered by **how reachable the entity is**, worst first: gone, then archived,
 * then live, and alphabetically inside each band. The ordering is the feature.
 * Somebody opening this page is nearly always here to close something, and the
 * shares they cannot reach any other way are exactly the ones that should not
 * be below the fold.
 */
export async function listMyShares(
  scope: OwnerScope,
  filters: MySharesFilters = {},
  now: Date = new Date()
): Promise<MyShareItem[]> {
  const listFilters = { includeInactive: filters.includeInactive ?? false };

  const [grants, links] = await Promise.all([
    listOwnGrants(scope, listFilters, now),
    listOwnShareLinks(scope, listFilters, now),
  ]);

  // Group first, resolve second. The grouping is what turns "N shares" into
  // "at most 6 title queries", so it has to happen before anything is fetched.
  const byEntity = new Map<string, MyShareItem>();
  const idsByType = new Map<ResparkableShareableType, Set<string>>();

  const bucket = (entityType: string, entityId: string): MyShareItem | null => {
    // A stored `entityType` outside the six means a row written before the
    // column was constrained, or by something that bypassed the schema. Skip
    // it rather than throw: one bad row must not take down the page that
    // exists to clean up bad state.
    if (!isResparkableShareableType(entityType)) return null;

    const key = `${entityType}:${entityId}`;
    let item = byEntity.get(key);
    if (!item) {
      item = { entityType, entityId, title: null, archived: false, grants: [], links: [] };
      byEntity.set(key, item);
      const ids = idsByType.get(entityType) ?? new Set<string>();
      ids.add(entityId);
      idsByType.set(entityType, ids);
    }
    return item;
  };

  for (const grant of grants) bucket(grant.entityType, grant.entityId)?.grants.push(grant);
  for (const link of links) bucket(link.entityType, link.entityId)?.links.push(link);

  // One query per type that actually has shares, never one per share.
  const resolved = await Promise.all(
    [...idsByType].map(async ([entityType, ids]) => ({
      entityType,
      items: await findSharedItems(scope, entityType, [...ids], false),
    }))
  );

  for (const group of resolved) {
    for (const view of group.items) {
      const item = byEntity.get(`${group.entityType}:${view.id}`);
      if (!item) continue;
      item.title = view.title;
      item.archived = view.archived;
    }
  }

  return [...byEntity.values()].sort(compareByReachability);
}

/** Gone, then archived, then live; alphabetical inside each band. */
function compareByReachability(a: MyShareItem, b: MyShareItem): number {
  const rank = (item: MyShareItem): number => (item.title === null ? 0 : item.archived ? 1 : 2);

  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;

  // A missing title sorts by type then id, so the order is at least stable.
  const left = a.title ?? `${a.entityType}:${a.entityId}`;
  const right = b.title ?? `${b.entityType}:${b.entityId}`;
  return left.localeCompare(right);
}

/** Totals for the page's summary line, computed where the rows are. */
export function summariseShares(items: readonly MyShareItem[]): {
  items: number;
  grants: number;
  links: number;
  unreachable: number;
} {
  return {
    items: items.length,
    grants: items.reduce((total, item) => total + item.grants.length, 0),
    links: items.reduce((total, item) => total + item.links.length, 0),
    // The number this page exists for: shares on something the owner cannot
    // navigate to, and therefore could not have revoked before it existed.
    unreachable: items.filter((item) => item.title === null || item.archived).length,
  };
}

/** Exported for the test that asserts the resolver covers every shareable type. */
export const MY_SHARES_TYPES = RESPARKABLE_SHAREABLE_TYPES;
