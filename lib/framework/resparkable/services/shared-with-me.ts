/**
 * `/shared-with-me` — the grantee's side, and the only surface in the tier that
 * reads across a person.
 *
 * ## Why this is a separate surface rather than a flag on the owner's lists
 *
 * Shared-in items do **not** appear in the viewer's own lists or search. Three
 * reasons, in the weight order §13 gives them:
 *
 *   1. It preserves `WHERE userId = $1` as an unconditional invariant on every
 *      list, search and embedding query in the tier. The moment one list can
 *      return a row belonging to somebody else, every list has to be audited for
 *      whether it does so correctly.
 *   2. A second brain's lists are a **planning** surface. Someone else's project
 *      sitting in "my projects" corrupts prioritisation and, worse, corrupts the
 *      owner's own sense of what they have committed to.
 *   3. Mixing them in would make roughly forty list endpoints potential leaks,
 *      rather than the handful in this file that have to be got right.
 *
 * ## What this file may not do
 *
 * **No writes.** There is no update path here and there must not be one: a
 * grant is `viewer` or `commenter`, and neither implies any authority over the
 * item itself. Commenting (phase 13) writes to a different table.
 *
 * **No `ResparkableEmbedding`.** {@link searchSharedWithMe} is a keyword filter
 * over an explicitly enumerated set of rows, never a vector query. The
 * embeddings belong to the **owner** and exist to serve the owner's own recall;
 * a grantee's search reaching into them would put another person's whole corpus
 * behind a text box, which is what §13 means by "shared-in items are excluded
 * from everything of the owner's".
 *
 * ## Every read is per-owner
 *
 * A viewer may hold grants from several people at once, and `findSharedItems`
 * takes an `SpaceScope` — deliberately, because a projection that could span
 * owners is a projection that could be handed the wrong one. So the work here is
 * grouped by owner first and queried per owner, and the group key is a real
 * `ownerId` read off a live grant, never anything from the request.
 */

import {
  grantSpaceScope,
  isResparkableShareableType,
  refKey,
  resparkableVisibilityScope,
  sharedSpaceScope,
  type LiveGrant,
  type ResparkableAccessResult,
  type ResparkableShareableType,
  type ResparkableViewer,
} from '@/lib/framework/resparkable/access';
import { RESPARKABLE_CASCADE } from '@/lib/framework/resparkable/access/cascade';
import { resolveResparkableAccess } from '@/lib/framework/resparkable/access/resolve';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import {
  findSharedChildIds,
  findSharedItems,
  SHARED_CHILD_LIMIT,
  type SharedItemView,
} from '@/lib/framework/resparkable/repo/shared-view';
import { buildBoardView } from '@/lib/framework/resparkable/services/board-view';
import {
  buildSharePayload,
  type PublicSharePayload,
} from '@/lib/framework/resparkable/services/sharing';
import type { SharedListQuery, SharedSearchQuery } from '@/lib/framework/resparkable/validations';

/**
 * How many rows one search may scan.
 *
 * The search loads the granted items and their one-level cascade through the
 * allowlisted projection and filters the normalised `{ title, body }` in
 * memory. That is the deliberate choice — see {@link searchSharedWithMe} — and
 * this is what stops it becoming unbounded when somebody is granted forty
 * projects of two hundred tasks each.
 *
 * A cap that silently truncates is a lie, so the result says whether it hit.
 */
export const SHARED_SEARCH_SCAN_LIMIT = 1000;

/** Who shared this, as a grantee is allowed to see them. */
export interface SharedOwnerIdentity {
  /** The account id. The grantee holds a relationship with a person, not an id. */
  id: string;
  name: string | null;
  email: string;
}

/** One item somebody has shared with me. */
export interface SharedWithMeItem {
  item: SharedItemView;
  /**
   * Present because the basis is a **grant**: a named share is a relationship,
   * and withholding who it is with would make the surface unusable. A public
   * link never carries this, which is the line the whole layer is drawn on.
   */
  owner: SharedOwnerIdentity;
  role: string;
  /** Whether this viewer may comment (phase 13). `commenter` grants only. */
  canComment: boolean;
  /** Whether prose bodies are open on tasks under this grant. */
  includeTaskDetail: boolean;
  sharedAt: Date;
  expiresAt: Date | null;
}

/**
 * Everything shared with this viewer, newest grant first.
 *
 * **Direct grants only.** A shared project's tasks are reachable by opening the
 * project, and they are not listed here — a list that flattened the cascade
 * would answer "what has Priya given me?" with two hundred rows when the honest
 * answer is "one project". The cascade is a property of the thing that was
 * handed over, not a second set of things that were.
 *
 * Anonymous viewers get an empty list rather than an error: this route is behind
 * a session, so a viewer with neither id nor address is a bug elsewhere, and an
 * empty list is the safe reading of it.
 */
export async function listSharedWithMe(
  viewer: ResparkableViewer,
  filters: SharedListQuery = {},
  now: Date = new Date()
): Promise<SharedWithMeItem[]> {
  const scope = await resparkableVisibilityScope(viewer, now);

  const grants = filters.entityType
    ? scope.grants.filter((grant) => grant.entityType === filters.entityType)
    : scope.grants;
  if (grants.length === 0) return [];

  const owners = await loadOwnerIdentities(grants, viewer.userId);

  // One query per (owner, type) pair rather than per grant. A person granted
  // twelve projects by one colleague costs one query, not twelve.
  const views = await loadViewsByOwnerAndType(grants, viewer.userId);

  const items: SharedWithMeItem[] = [];
  for (const grant of grants) {
    const owner = owners.get(grant.ownerId);
    const item = views.get(viewKey(grant.ownerId, grant.entityType, grant.entityId));
    // An owner erased mid-flight, or an item deleted since the grant was
    // issued. Absent rather than an error: the grantee cannot act on either,
    // and a broken row in a list is worse than a shorter list.
    if (!owner || !item) continue;

    items.push({
      item,
      owner,
      role: grant.role,
      canComment: grant.role === 'commenter',
      includeTaskDetail: grant.includeTaskDetail,
      sharedAt: grant.createdAt,
      expiresAt: grant.expiresAt,
    });
  }

  return items;
}

/**
 * One shared item and its cascade, resolved for this viewer.
 *
 * Goes through `resolveResparkableAccess` rather than trusting the list, so a
 * grant revoked between the list rendering and the item being opened is a 404
 * on **this** request. That is the whole reason the resolver is uncached.
 *
 * Returns `null` for denied, unknown and deleted alike — the route turns all
 * three into the same 404, for the reason every other read in this tier does.
 */
export async function readSharedWithMe(
  viewer: ResparkableViewer,
  ref: { entityType: string; entityId: string },
  now: Date = new Date()
): Promise<{
  payload: PublicSharePayload;
  access: ResparkableAccessResult;
  owner: SharedOwnerIdentity;
} | null> {
  const access = await resolveResparkableAccess({
    viewer,
    entityType: ref.entityType,
    entityId: ref.entityId,
    need: 'read',
    now,
  });

  // The owner reaching their own item through this route is a denial, not a
  // convenience. `/shared-with-me` is the surface for other people's things;
  // serving the owner here would give them a second, differently-redacted view
  // of their own brain and a second set of rules to keep in step.
  if (!access.ok || access.basis === 'owner' || !access.ownerId) return null;

  // A public link cannot reach this route — `ResparkableViewer` has no token
  // field — so a positive result here is always a grant or a grant cascade.
  const scope = sharedSpaceScope(access, viewer.userId);
  const owner = await identityFor(scope, access.ownerId);
  if (!owner) return null;

  // Narrowed by a guard rather than asserted by a cast. The resolver has
  // already denied anything not on the shareable list, so the assertion would
  // have been true — but true-because-something-else-checked is the shape that
  // stops being true when the something else moves.
  if (!isResparkableShareableType(ref.entityType)) return null;

  const payload = await buildSharePayload(
    access,
    {
      entityType: ref.entityType,
      entityId: ref.entityId,
      // The flag lives on the grant, and the resolver has already folded it
      // into `redact`: `notes` is absent from the list exactly when the grant
      // opened it. Reading it back off the redaction set rather than
      // re-querying the grant keeps one answer to "may this reader see prose".
      includeTaskDetail: !access.redact.includes('notes'),
    },
    // **Children only for a DIRECTLY granted item**, never for a cascaded one.
    //
    // A bare `true` here walked the cascade twice, and `goal → goal` is the
    // shape that made it reachable: a grant on a top-level goal cascades to its
    // children, and expanding a child's children then serialised a
    // *grandchild* — an item `resolveResparkableAccess` denies outright, as
    // `resolve.test.ts` asserts. The reader was handed, in one payload, the
    // very row the next request would 404 on.
    //
    // A cascaded item is a leaf of the share by definition: it was never chosen
    // for sharing by its owner, and it reaches the reader only because
    // something above it was. That makes it exactly the wrong place to expand
    // from. `access.basis` is where the resolver already recorded which of the
    // two this is, so asking it keeps one answer to "how far does this share
    // go" rather than a second one here.
    access.basis === 'grant',
    now
  );
  if (!payload) return null;

  return { payload, access, owner };
}

/** What a shared search matched, and whether it saw everything. */
export interface SharedSearchResult {
  items: Array<{ item: SharedItemView; owner: SharedOwnerIdentity; via: string | null }>;
  /** True when the scan hit {@link SHARED_SEARCH_SCAN_LIMIT} and stopped short. */
  truncated: boolean;
}

/**
 * Keyword search across what has been shared with me.
 *
 * **A different mechanism from the owner's search, on purpose.** The owner's is
 * hybrid: a vector query against `ResparkableEmbedding` blended with BM25. This
 * one enumerates the granted refs and their one-level cascade, projects them
 * through the same allowlist the public reader uses, and filters the normalised
 * `title` and `body` in memory.
 *
 * Three consequences worth stating rather than discovering:
 *
 *   1. **It cannot touch the owner's embeddings**, because it never issues a
 *      query that could. That is a structural guarantee rather than a filter
 *      somebody has to keep correct — §16.5 asks for exactly this, and asks for
 *      it to be provable by inspecting the queries rather than by mocking.
 *   2. **It is a substring match, not a semantic one.** A grantee searching
 *      "deadline" will not find "due Friday". That is the honest cost of not
 *      having the owner's index, and the UI should not imply otherwise.
 *   3. **It filters the projection, not the table.** A field the projection
 *      withholds — `notes` on a task under a grant that did not open them — is
 *      not searched, so a query cannot be used to probe for the presence of
 *      words in text the viewer is not allowed to read.
 */
export async function searchSharedWithMe(
  viewer: ResparkableViewer,
  query: SharedSearchQuery,
  now: Date = new Date()
): Promise<SharedSearchResult> {
  const scope = await resparkableVisibilityScope(viewer, now);
  if (scope.grants.length === 0) return { items: [], truncated: false };

  const owners = await loadOwnerIdentities(scope.grants, viewer.userId);
  const { refs, truncated } = await collectSearchableRefs(
    scope.grants,
    query.entityType,
    now,
    viewer.userId
  );
  if (refs.length === 0) return { items: [], truncated };

  const needle = query.q.toLowerCase();
  const results: SharedSearchResult['items'] = [];

  // Grouped by (owner, type, detail) so the projection is asked once per group
  // with the right scope and the right prose flag, never once per row.
  for (const group of groupRefs(refs)) {
    const owner = owners.get(group.ownerId);
    if (!owner) continue;

    const items = await findSharedItems(group.scope, group.entityType, group.ids, group.withDetail);

    for (const item of items) {
      const haystack = `${item.title}\n${item.body ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      results.push({ item, owner, via: group.viaByIdKey.get(item.id) ?? null });
    }
  }

  return { items: results, truncated };
}

// ─── Internals ───────────────────────────────────────────────────────────────

function viewKey(ownerId: string, entityType: string, entityId: string): string {
  return `${ownerId}:${entityType}:${entityId}`;
}

/**
 * The owners behind a set of grants, one contact lookup each.
 *
 * `findOwnerContact` takes an `SpaceScope`, and the id it is given comes off a
 * live grant row — never off the request. That is the same discipline
 * `sharedSpaceScope` documents, reached without a resolution because a grant
 * the viewer holds already *is* the resolution.
 */
async function loadOwnerIdentities(
  grants: readonly LiveGrant[],
  actorUserId: string | null
): Promise<Map<string, SharedOwnerIdentity>> {
  // One grant per distinct owner is enough to mint that owner's scope, and
  // asking twice for the same address would be two queries for one answer.
  const firstPerOwner = new Map<string, LiveGrant>();
  for (const grant of grants) {
    if (!firstPerOwner.has(grant.ownerId)) firstPerOwner.set(grant.ownerId, grant);
  }

  const entries = await Promise.all(
    [...firstPerOwner.values()].map(
      async (grant) =>
        [
          grant.ownerId,
          await identityFor(grantSpaceScope(grant, actorUserId), grant.ownerId),
        ] as const
    )
  );

  const map = new Map<string, SharedOwnerIdentity>();
  for (const [id, identity] of entries) {
    if (identity) map.set(id, identity);
  }
  return map;
}

async function identityFor(
  scope: SpaceScope,
  ownerId: string
): Promise<SharedOwnerIdentity | null> {
  const contact = await findOwnerContact(scope);
  if (!contact) return null;
  return { id: ownerId, name: contact.name, email: contact.email };
}

/** Load the directly-granted items, one query per (owner, type) pair. */
async function loadViewsByOwnerAndType(
  grants: readonly LiveGrant[],
  actorUserId: string | null
): Promise<Map<string, SharedItemView>> {
  // Detail is per grant, so a pair holding one grant with prose and one without
  // has to be asked twice. Grouping by the flag as well keeps that honest
  // rather than letting the first grant in a pair decide for the rest.
  const groups = new Map<
    string,
    {
      ownerId: string;
      /** Minted from the first grant in the group — never from a loop variable. */
      scope: SpaceScope;
      entityType: ResparkableShareableType;
      withDetail: boolean;
      ids: string[];
    }
  >();

  for (const grant of grants) {
    const key = `${grant.ownerId}:${grant.entityType}:${grant.includeTaskDetail}`;
    const group = groups.get(key);
    if (group) group.ids.push(grant.entityId);
    else
      groups.set(key, {
        ownerId: grant.ownerId,
        scope: grantSpaceScope(grant, actorUserId),
        entityType: grant.entityType,
        withDetail: grant.includeTaskDetail,
        ids: [grant.entityId],
      });
  }

  const views = new Map<string, SharedItemView>();
  for (const group of groups.values()) {
    const items = await findSharedItems(group.scope, group.entityType, group.ids, group.withDetail);
    for (const item of items) {
      views.set(viewKey(group.ownerId, group.entityType, item.id), item);
    }
  }
  return views;
}

interface SearchableRef {
  ownerId: string;
  /**
   * Minted from the grant this ref was reached through. Carried on the ref
   * rather than rebuilt from `ownerId` at query time, so the only way a scope
   * exists in this file is via a grant the viewer actually holds.
   */
  scope: SpaceScope;
  entityType: ResparkableShareableType;
  entityId: string;
  withDetail: boolean;
  /** The granted parent this ref was reached through, or `null` if it is one. */
  via: string | null;
}

/**
 * The refs a search may look at: every direct grant, plus one level of cascade.
 *
 * The cascade is read from `RESPARKABLE_CASCADE` rather than re-derived, so
 * "what does a search reach?" and "what does a grant grant?" cannot answer
 * differently. A board's children come from `buildBoardView` for the reason
 * `services/sharing.ts` gives: a filter board's membership is a live query, and
 * a second copy of the predicate is a shared board that disagrees with itself.
 *
 * Stops at {@link SHARED_SEARCH_SCAN_LIMIT} and reports that it did.
 */
async function collectSearchableRefs(
  grants: readonly LiveGrant[],
  entityType: ResparkableShareableType | undefined,
  now: Date,
  actorUserId: string | null
): Promise<{ refs: SearchableRef[]; truncated: boolean }> {
  const refs: SearchableRef[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const push = (ref: SearchableRef): boolean => {
    if (refs.length >= SHARED_SEARCH_SCAN_LIMIT) {
      truncated = true;
      return false;
    }
    const key = `${ref.ownerId}:${refKey(ref)}`;
    if (seen.has(key)) return true;
    seen.add(key);
    refs.push(ref);
    return true;
  };

  for (const grant of grants) {
    const scope = grantSpaceScope(grant, actorUserId);

    if (!entityType || grant.entityType === entityType) {
      if (
        !push({
          ownerId: grant.ownerId,
          scope,
          entityType: grant.entityType,
          entityId: grant.entityId,
          withDetail: grant.includeTaskDetail,
          via: null,
        })
      )
        break;
    }

    const childTypes = RESPARKABLE_CASCADE[grant.entityType];
    if (childTypes.length === 0) continue;
    // The caller narrowed to a type the cascade cannot produce, so there is
    // nothing to fetch — and fetching it anyway would spend a query per grant
    // to throw the answer away.
    if (entityType && !childTypes.includes(entityType)) continue;

    const children = await childRefsFor(scope, grant, now);
    for (const child of children) {
      if (entityType && child.entityType !== entityType) continue;
      if (
        !push({
          ...child,
          ownerId: grant.ownerId,
          scope,
          withDetail: grant.includeTaskDetail,
          via: grant.entityId,
        })
      )
        break;
    }
    if (truncated) break;
  }

  return { refs, truncated };
}

async function childRefsFor(
  scope: SpaceScope,
  grant: LiveGrant,
  now: Date
): Promise<Array<{ entityType: ResparkableShareableType; entityId: string; via: string }>> {
  if (grant.entityType === 'board') {
    const view = await buildBoardView(scope, grant.entityId, now);
    if (!view) return [];
    const ids = [
      ...view.columns.flatMap((column) => column.cards.map((card) => card.task.id)),
      ...view.unplaced.map((card) => card.task.id),
    ].slice(0, SHARED_CHILD_LIMIT);
    return ids.map((id) => ({ entityType: 'task' as const, entityId: id, via: grant.entityId }));
  }

  const children = await findSharedChildIds(scope, grant.entityType, grant.entityId);
  if (!children) return [];
  return children.ids
    .slice(0, SHARED_CHILD_LIMIT)
    .map((id) => ({ entityType: children.childType, entityId: id, via: grant.entityId }));
}

interface RefGroup {
  ownerId: string;
  scope: SpaceScope;
  entityType: ResparkableShareableType;
  withDetail: boolean;
  ids: string[];
  viaByIdKey: Map<string, string | null>;
}

function groupRefs(refs: readonly SearchableRef[]): RefGroup[] {
  const groups = new Map<string, RefGroup>();
  for (const ref of refs) {
    const key = `${ref.ownerId}:${ref.entityType}:${ref.withDetail}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        ownerId: ref.ownerId,
        scope: ref.scope,
        entityType: ref.entityType,
        withDetail: ref.withDetail,
        ids: [],
        viaByIdKey: new Map(),
      };
      groups.set(key, group);
    }
    group.ids.push(ref.entityId);
    group.viaByIdKey.set(ref.entityId, ref.via);
  }
  return [...groups.values()];
}
