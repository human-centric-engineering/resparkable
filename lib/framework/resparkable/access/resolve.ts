/**
 * `resolveResparkableAccess` — the one answer to "may this viewer see this?".
 *
 * Modelled on `adminCanViewConversation` (`lib/orchestration/access/`), which
 * is the correct existing precedent: a pure read returning `{ ok, basis,
 * ownerId }`, no audit writes, and a denial that reveals nothing about whether
 * the row exists.
 *
 * ## The owner short-circuit, and why it comes first
 *
 * Almost every call to this function is someone reading their own brain. That
 * path is **one indexed lookup of a single column** and then a string
 * comparison — no grant query, no link query, no cascade. Anything else would
 * put a join on the hot path of a product whose whole job is to be faster than
 * thinking.
 *
 * It also matters for a reason that is not performance. **The owner's own agent
 * sees all of the owner's items regardless of `visibility`.** `visibility` is
 * only ever about the public-link surface; it is never a filter on an owner
 * read. Short-circuiting before anything looks at that column is what makes
 * that structurally true rather than a comment somebody might later "helpfully"
 * contradict by adding `visibility: 'private'` to an agent query.
 *
 * ## What this function does NOT do
 *
 *   • **It never consults a share link.** A public link is resolved by
 *     {@link resolveResparkableShareLink}, from the public reader only. A token
 *     presented alongside a session buys nothing here, which is how "a public
 *     link grants no access to the authenticated route" (§16.4) stays true
 *     without twenty routes remembering a rule.
 *   • **It is not called by owner write paths.** Those take an `OwnerScope` and
 *     go through `repo/**`; adding a resolution step would mean a write path
 *     that *could* be told yes about someone else's row.
 *   • **It is not cached beyond a request.** Revocation must be immediate: a
 *     grantee who has been cut off 404s on their next request, not after a TTL.
 *
 * ## Not-found and not-yours are the same answer
 *
 * Every denial is the same frozen `DENY`, carrying `ownerId: null` even when
 * the row exists and has an owner. Returning the owner on a denial would be a
 * user-enumeration vector, and routes translate both to 404.
 */

import {
  findCascadeParents,
  RESPARKABLE_CASCADE_PARENTS,
} from '@/lib/framework/resparkable/access/cascade';
import {
  findEntityOwner,
  findEntityOwners,
  findLiveGrantsForRefs,
  findLiveGrantsForViewer,
  findLiveShareLinkByTokenHash,
} from '@/lib/framework/resparkable/access/store';
import {
  ALL_REDACTIONS,
  DENY,
  isResparkableShareableType,
  refKey,
  type LiveGrant,
  type LiveShareLink,
  type ResparkableAccessBasis,
  type ResparkableAccessResult,
  type ResparkableEntityRef,
  type ResparkableNeed,
  type ResparkableShareableType,
  type ResparkableViewer,
  type ResparkableVisibilityScope,
} from '@/lib/framework/resparkable/access/types';
import { createHash } from 'crypto';

export interface ResolveAccessInput {
  viewer: ResparkableViewer;
  entityType: string;
  entityId: string;
  /** Defaults to `'read'`. `'comment'` additionally requires a commenter grant. */
  need?: ResparkableNeed;
  /** One instant for a whole batch, so two rows cannot expire under two clocks. */
  now?: Date;
}

/** The owner sees everything of their own: nothing to hide from yourself. */
const OWNER_RESULT = (ownerId: string): ResparkableAccessResult => ({
  ok: true,
  basis: 'owner',
  ownerId,
  permissions: { read: true, comment: true },
  redact: [],
  via: null,
});

/**
 * What a shared reader may see, by basis.
 *
 * Expressed as **what a basis removes from {@link ALL_REDACTIONS}**, not as
 * what it allows, so a redaction added tomorrow applies to every basis until
 * somebody decides otherwise. Failing closed on a field nobody has thought
 * about yet is the only safe default here.
 *
 * The line between a link and a grant is the product's own: **a public link is
 * a document, a named grant is a relationship.** A stranger holding a URL gets
 * the content and nothing about the person; someone the owner named gets to
 * know who shared it and to say something back.
 */
function redactionsFor(
  basis: ResparkableAccessBasis,
  includeTaskDetail: boolean
): {
  redact: readonly ResparkableAccessResult['redact'][number][];
  comment: boolean;
} {
  const allowed = new Set<string>();

  if (basis === 'grant' || basis === 'grant-cascade') {
    // A named grantee sees who shared it and the conversation on it.
    allowed.add('ownerIdentity');
    allowed.add('comments');
  }

  // `notes` is the only field either basis can open, and only deliberately.
  if (includeTaskDetail) allowed.add('notes');

  return {
    redact: ALL_REDACTIONS.filter((field) => !allowed.has(field)),
    comment: false,
  };
}

function sharedResult(
  basis: ResparkableAccessBasis,
  ownerId: string,
  options: { includeTaskDetail: boolean; canComment: boolean; via: ResparkableEntityRef | null }
): ResparkableAccessResult {
  const { redact } = redactionsFor(basis, options.includeTaskDetail);
  return {
    ok: true,
    basis,
    ownerId,
    permissions: { read: true, comment: options.canComment },
    redact,
    via: options.via,
  };
}

/**
 * Resolve one item for one signed-in (or anonymous) viewer.
 *
 * Query cost: one lookup for an owner read; at most one more for a direct
 * grant; one more again for the cascade, and only when the type has a parent
 * type at all (`RESPARKABLE_CASCADE_PARENTS`), so a project, an area and a
 * review never pay for a cascade that cannot exist.
 */
export async function resolveResparkableAccess(
  input: ResolveAccessInput
): Promise<ResparkableAccessResult> {
  const { viewer, entityId } = input;
  const need = input.need ?? 'read';
  const now = input.now ?? new Date();

  // A `thought` — or anything not on the shareable list — is denied before a
  // single query runs. The inbox is unshareable by construction, not by a
  // missing grant.
  if (!isResparkableShareableType(input.entityType)) return DENY;
  const entityType: ResparkableShareableType = input.entityType;

  const ownerId = await findEntityOwner(entityType, entityId);
  if (!ownerId) return DENY;

  // ── The short circuit. Before any grant or link query. ────────────────────
  if (viewer.userId && viewer.userId === ownerId) return OWNER_RESULT(ownerId);

  const ref: ResparkableEntityRef = { entityType, entityId };

  const direct = await findLiveGrantsForRefs(viewer, [ref], now);
  const directGrant = best(direct);
  if (directGrant) {
    const canComment = directGrant.role === 'commenter';
    if (need === 'comment' && !canComment) return DENY;
    return sharedResult('grant', ownerId, {
      includeTaskDetail: directGrant.includeTaskDetail,
      canComment,
      via: null,
    });
  }

  if (RESPARKABLE_CASCADE_PARENTS[entityType].length === 0) return DENY;

  const parentsByChild = await findCascadeParents(ownerId, [ref]);
  const parents = parentsByChild.get(refKey(ref)) ?? [];
  if (parents.length === 0) return DENY;

  const inherited = await findLiveGrantsForRefs(viewer, parents, now);
  const parentGrant = best(inherited);
  if (!parentGrant) return DENY;

  // A cascaded item was never chosen for sharing by its owner, so commenting on
  // it is not implied by a commenter role on the parent. Commenting is a thing
  // you do to the item that was actually handed over.
  if (need === 'comment') return DENY;

  return sharedResult('grant-cascade', ownerId, {
    includeTaskDetail: parentGrant.includeTaskDetail,
    canComment: false,
    via: { entityType: parentGrant.entityType, entityId: parentGrant.entityId },
  });
}

/**
 * The batched form. **Lists must use this.**
 *
 * A shared board is a list of tasks, and `task` is the highest-cardinality
 * shareable type — resolving a fifty-card board one call at a time would be
 * two hundred queries for one page. This is four, whatever the list size: the
 * owners, the direct grants, the cascade parents, and the inherited grants.
 *
 * Returns a map keyed by `type:id`. An id absent from the map was denied; the
 * caller drops it from the list rather than rendering a placeholder, because a
 * placeholder discloses that a hidden thing exists.
 */
export async function resolveResparkableAccessMany(input: {
  viewer: ResparkableViewer;
  refs: readonly { entityType: string; entityId: string }[];
  need?: ResparkableNeed;
  now?: Date;
}): Promise<Map<string, ResparkableAccessResult>> {
  const need = input.need ?? 'read';
  const now = input.now ?? new Date();
  const results = new Map<string, ResparkableAccessResult>();

  const refs = input.refs
    .filter((ref): ref is ResparkableEntityRef => isResparkableShareableType(ref.entityType))
    .filter((ref, index, all) => all.findIndex((other) => refKey(other) === refKey(ref)) === index);

  if (refs.length === 0) return results;

  // ── Owners, one query per distinct type ──────────────────────────────────
  const byType = new Map<ResparkableShareableType, string[]>();
  for (const ref of refs) {
    const ids = byType.get(ref.entityType);
    if (ids) ids.push(ref.entityId);
    else byType.set(ref.entityType, [ref.entityId]);
  }

  const owners = new Map<string, string>();
  await Promise.all(
    [...byType].map(async ([entityType, ids]) => {
      const found = await findEntityOwners(entityType, ids);
      for (const [id, ownerId] of found) owners.set(`${entityType}:${id}`, ownerId);
    })
  );

  const unresolved: ResparkableEntityRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    const ownerId = owners.get(key);
    if (!ownerId) {
      results.set(key, DENY);
      continue;
    }
    if (input.viewer.userId && input.viewer.userId === ownerId) {
      results.set(key, OWNER_RESULT(ownerId));
      continue;
    }
    unresolved.push(ref);
  }

  if (unresolved.length === 0) return results;

  // ── Direct grants, one query for the whole remainder ─────────────────────
  const directGrants = indexGrants(await findLiveGrantsForRefs(input.viewer, unresolved, now));

  const stillUnresolved: ResparkableEntityRef[] = [];
  for (const ref of unresolved) {
    const key = refKey(ref);
    const grant = directGrants.get(key);
    if (!grant) {
      stillUnresolved.push(ref);
      continue;
    }
    const canComment = grant.role === 'commenter';
    if (need === 'comment' && !canComment) {
      results.set(key, DENY);
      continue;
    }
    results.set(
      key,
      sharedResult('grant', grant.ownerId, {
        includeTaskDetail: grant.includeTaskDetail,
        canComment,
        via: null,
      })
    );
  }

  // A cascaded item can never satisfy `need: 'comment'`, so the two remaining
  // queries are skipped entirely rather than run and then discarded.
  if (stillUnresolved.length === 0 || need === 'comment') {
    for (const ref of stillUnresolved) results.set(refKey(ref), DENY);
    return results;
  }

  // ── The cascade, batched per owner ───────────────────────────────────────
  //
  // Grouped by owner because a cascade only ever runs inside one brain: a task
  // belonging to A can only be reached through A's project or A's board. The
  // grouping is what keeps that a property of the query rather than of a
  // filter applied afterwards.
  const byOwner = new Map<string, ResparkableEntityRef[]>();
  for (const ref of stillUnresolved) {
    const ownerId = owners.get(refKey(ref));
    if (!ownerId) continue;
    const list = byOwner.get(ownerId);
    if (list) list.push(ref);
    else byOwner.set(ownerId, [ref]);
  }

  const parentsByChild = new Map<string, ResparkableEntityRef[]>();
  await Promise.all(
    [...byOwner].map(async ([ownerId, ownedRefs]) => {
      const found = await findCascadeParents(ownerId, ownedRefs);
      for (const [childKey, parents] of found) parentsByChild.set(childKey, parents);
    })
  );

  const allParents = [...parentsByChild.values()].flat();
  const inherited = indexGrants(await findLiveGrantsForRefs(input.viewer, allParents, now));

  for (const ref of stillUnresolved) {
    const key = refKey(ref);
    const ownerId = owners.get(key);
    const parents = parentsByChild.get(key) ?? [];
    const parentGrant = parents.map((parent) => inherited.get(refKey(parent))).find(Boolean);

    if (!ownerId || !parentGrant) {
      results.set(key, DENY);
      continue;
    }

    results.set(
      key,
      sharedResult('grant-cascade', ownerId, {
        includeTaskDetail: parentGrant.includeTaskDetail,
        canComment: false,
        via: { entityType: parentGrant.entityType, entityId: parentGrant.entityId },
      })
    );
  }

  return results;
}

/**
 * What this viewer can currently see, resolved in one query.
 *
 * The input to `/shared-with-me` and to any list that has to answer "which of
 * these are shared with me?" without asking per row.
 *
 * **Shared-in items get their own surface — they do NOT appear in the viewer's
 * own lists or search.** Three reasons, in weight order: it preserves
 * `WHERE userId = $1` as an unconditional invariant on every list, search and
 * embedding query; a second brain's lists are a *planning* surface, and someone
 * else's project sitting in "my projects" corrupts both prioritisation and your
 * own sense of what you have committed to; and mixing them in would make ~40
 * list endpoints potential leaks rather than the ~6 that have to be got right.
 */
export async function resparkableVisibilityScope(
  viewer: ResparkableViewer,
  now: Date = new Date()
): Promise<ResparkableVisibilityScope> {
  const grants = await findLiveGrantsForViewer(viewer, now);

  const directRefsByType = new Map<ResparkableShareableType, string[]>();
  for (const grant of grants) {
    const ids = directRefsByType.get(grant.entityType);
    if (ids) ids.push(grant.entityId);
    else directRefsByType.set(grant.entityType, [grant.entityId]);
  }

  return { viewer, grants, directRefsByType };
}

// ─── Public links ────────────────────────────────────────────────────────────

/**
 * Hash a share token the one way this system hashes them.
 *
 * sha256, hex, no salt — the token is 192 bits of randomness, so a salt buys
 * nothing against a table this is looked up in by exact digest, and a
 * per-row salt would make that lookup impossible.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Resolve a public link, from the public reader and nowhere else.
 *
 * Returns `null` for unknown, tampered, revoked and expired alike — §16.4 asks
 * for exactly that, because anything else turns the 404 into an oracle telling
 * a stranger which tokens once existed.
 */
export async function resolveResparkableShareLink(
  token: string,
  now: Date = new Date()
): Promise<LiveShareLink | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  return findLiveShareLinkByTokenHash(hashShareToken(token), now);
}

/**
 * The access result a live link produces for the item it names.
 *
 * Separate from {@link resolveResparkableShareLink} so the reader route can
 * hold the link (for `includeChildren`, for the view counter) without each call
 * site re-deriving what a link permits.
 */
export function shareLinkAccess(link: LiveShareLink): ResparkableAccessResult {
  return sharedResult('link', link.ownerId, {
    includeTaskDetail: link.includeTaskDetail,
    canComment: false,
    via: null,
  });
}

/**
 * Does this link reach this child item, and on what terms?
 *
 * The cascade half of the public reader. `includeChildren` off means the link
 * shows exactly one item, so this denies without a query — a link the owner
 * scoped to one project must not start disclosing tasks because a reader
 * guessed a child URL.
 */
export async function resolveResparkableShareLinkChild(
  link: LiveShareLink,
  child: { entityType: string; entityId: string }
): Promise<ResparkableAccessResult> {
  if (!link.includeChildren) return DENY;
  if (!isResparkableShareableType(child.entityType)) return DENY;

  const ref: ResparkableEntityRef = {
    entityType: child.entityType,
    entityId: child.entityId,
  };

  // The child must belong to the link's owner. Checked before the cascade
  // rather than inferred from it: an id from a URL is attacker-supplied, and
  // "whose row is this?" is the question that must not be skipped.
  const ownerId = await findEntityOwner(ref.entityType, ref.entityId);
  if (ownerId !== link.ownerId) return DENY;

  const parents = (await findCascadeParents(link.ownerId, [ref])).get(refKey(ref)) ?? [];
  const reached = parents.some(
    (parent) => parent.entityType === link.entityType && parent.entityId === link.entityId
  );
  if (!reached) return DENY;

  return sharedResult('link-cascade', link.ownerId, {
    includeTaskDetail: link.includeTaskDetail,
    canComment: false,
    via: { entityType: link.entityType, entityId: link.entityId },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The strongest of several grants on one item.
 *
 * A commenter grant beats a viewer grant, and detail beats no detail. The
 * unique index means one address holds at most one grant per item, so this only
 * fires when a viewer matches by both `granteeUserId` and `granteeEmail` — the
 * mid-acceptance state — and picking the stronger there is what stops accepting
 * an invite briefly *reducing* what someone can do.
 */
function best(grants: readonly LiveGrant[]): LiveGrant | null {
  if (grants.length === 0) return null;
  return [...grants].sort((left, right) => rank(right) - rank(left))[0];
}

function rank(grant: LiveGrant): number {
  return (grant.role === 'commenter' ? 2 : 0) + (grant.includeTaskDetail ? 1 : 0);
}

/** Index grants by `type:id`, keeping the strongest per item. */
function indexGrants(grants: readonly LiveGrant[]): Map<string, LiveGrant> {
  const indexed = new Map<string, LiveGrant>();
  for (const grant of grants) {
    const key = `${grant.entityType}:${grant.entityId}`;
    const existing = indexed.get(key);
    if (!existing || rank(grant) > rank(existing)) indexed.set(key, grant);
  }
  return indexed;
}
