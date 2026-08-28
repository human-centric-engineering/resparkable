/**
 * The sharing service — minting a link, revoking one, and rendering what a
 * stranger holding one is allowed to see.
 *
 * Three things live here rather than in a route or a repo:
 *
 *   1. **The token exists in memory for one function call.** `mintShareLink`
 *      generates it, hashes it, stores the digest and returns the plaintext to
 *      its caller **once**. Nothing else in the codebase can produce it again —
 *      not the owner's own link list, not an export, not a database dump. A
 *      lost link is re-minted, not recovered, and the UI has to say so.
 *   2. **The public payload is assembled in one place.** Redaction is decided
 *      by `access/**`, the projection is enforced by `repo/shared-view.ts`, and
 *      this is where the two meet. Assembling it per route would mean the rules
 *      held in as many places as there are routes.
 *   3. **A board's children come from `board-view.ts`.** A filter-backed board
 *      is a live query, and its membership must be resolved by the module that
 *      renders it — a second copy of the filter predicate is precisely what
 *      `access/cascade.ts` warns about, and here the disagreement would be
 *      visible as a shared board showing different cards from the owner's.
 */

import {
  resolveResparkableShareLink,
  shareLinkAccess,
  sharedOwnerScope,
} from '@/lib/framework/resparkable/access';
import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import type {
  LiveShareLink,
  ResparkableAccessResult,
  ResparkableShareableType,
} from '@/lib/framework/resparkable/access/types';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  createShareLink,
  countShareLinkView,
  listShareLinks,
  ownsEntity,
  revokeShareLink as revokeShareLinkRow,
  type ShareLinkFilters,
} from '@/lib/framework/resparkable/repo/share-links';
import {
  findSharedChildIds,
  findSharedItem,
  findSharedItems,
  SHARED_CHILD_LIMIT,
  type SharedItemView,
} from '@/lib/framework/resparkable/repo/shared-view';
import { buildBoardView } from '@/lib/framework/resparkable/services/board-view';
import type { CreateShareLinkInput } from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import type { ResparkableShareLink } from '@prisma/client';
import { randomBytes } from 'crypto';

/**
 * 24 random bytes, base64url. 192 bits, 32 characters.
 *
 * **Deliberately not a cuid**, which every other id in this codebase is. Cuids
 * are timestamp-prefixed and monotonic — excellent for a primary key, precisely
 * wrong for a value whose only defence is that nobody can guess it. `randomBytes`
 * is CSPRNG-backed; `Math.random` is not, and the difference does not show up in
 * any test.
 */
function mintToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface MintedShareLink {
  link: ResparkableShareLink;
  /**
   * The plaintext token. **Returned once and never recoverable.** Put it in the
   * response body and nowhere else — never in a log line, never in an audit
   * row, never on the link row.
   */
  token: string;
}

/**
 * The default and maximum expiry, as §13 sets them.
 *
 * Thirty days is short enough that a link shared for one conversation stops
 * working after that conversation, and long enough that nobody has to think
 * about it. A year is the ceiling because a bearer credential to someone's
 * notes that outlives the reason it was issued is the shape of the problem.
 */
export const SHARE_LINK_DEFAULT_DAYS = 30;
export const SHARE_LINK_MAX_DAYS = 365;

function resolveExpiry(expiry: CreateShareLinkInput['expiry'], now: Date): Date | null {
  if (expiry.kind === 'never') return null;
  return new Date(now.getTime() + expiry.days * 24 * 60 * 60 * 1000);
}

/**
 * Mint a public link for one of the owner's items.
 *
 * Returns `null` when the item is not the owner's or does not exist, rather
 * than minting a token that would 404 for its own creator.
 */
export async function mintShareLink(
  scope: OwnerScope,
  input: CreateShareLinkInput,
  now: Date = new Date()
): Promise<MintedShareLink | null> {
  if (!(await ownsEntity(scope, input.entityType, input.entityId))) return null;

  const token = mintToken();

  const link = await createShareLink(scope, {
    entityType: input.entityType,
    entityId: input.entityId,
    tokenHash: hashShareToken(token),
    // Enough to tell two links apart in a list, far too little to guess the
    // rest of 192 bits from.
    tokenPrefix: token.slice(0, 8),
    includeChildren: input.includeChildren,
    includeTaskDetail: input.includeTaskDetail,
    expiresAt: resolveExpiry(input.expiry, now),
  });

  // No token, no prefix, no entity id. A log line is the one place a secret
  // most reliably outlives the system that made it.
  logger.info('Resparkable share link minted', {
    entityType: link.entityType,
    includeChildren: link.includeChildren,
    includeTaskDetail: link.includeTaskDetail,
    expires: link.expiresAt !== null,
  });

  return { link, token };
}

/** The owner's own links. Never includes a token or a digest — see below. */
export async function listOwnShareLinks(
  scope: OwnerScope,
  filters: ShareLinkFilters = {},
  now: Date = new Date()
): Promise<PublicShareLinkSummary[]> {
  const links = await listShareLinks(scope, filters, now);
  return links.map((link) => toSummary(link, now));
}

export async function revokeShareLink(
  scope: OwnerScope,
  id: string,
  now: Date = new Date()
): Promise<ResparkableShareLink | null> {
  const revoked = await revokeShareLinkRow(scope, id, now);
  if (revoked) logger.info('Resparkable share link revoked', { entityType: revoked.entityType });
  return revoked;
}

/**
 * A link as its own owner sees it in a list.
 *
 * **`tokenHash` is absent.** It is not a secret in the sense the token is — a
 * sha256 digest is not reversible — but it is the exact value the public lookup
 * matches on, and there is no reason for it to travel to a browser, into a
 * client-side store, or through a screenshot. `tokenPrefix` is what answers
 * "which link is this?".
 */
export interface PublicShareLinkSummary {
  id: string;
  entityType: string;
  entityId: string;
  tokenPrefix: string;
  includeChildren: boolean;
  includeTaskDetail: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
  viewCount: number;
  lastViewedAt: Date | null;
  createdAt: Date;
}

function toSummary(link: ResparkableShareLink, now: Date): PublicShareLinkSummary {
  return {
    id: link.id,
    entityType: link.entityType,
    entityId: link.entityId,
    tokenPrefix: link.tokenPrefix,
    includeChildren: link.includeChildren,
    includeTaskDetail: link.includeTaskDetail,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    active: link.revokedAt === null && (link.expiresAt === null || link.expiresAt > now),
    viewCount: link.viewCount,
    lastViewedAt: link.lastViewedAt,
    createdAt: link.createdAt,
  };
}

// ─── The public reader ───────────────────────────────────────────────────────

/** What `/s/[token]` renders. Everything here is safe for a stranger to hold. */
export interface PublicSharePayload {
  item: SharedItemView;
  /** Empty when `includeChildren` is off, or when the item has no children. */
  children: SharedItemView[];
  /** True when the cascade was capped, so the page can say so rather than lie. */
  childrenTruncated: boolean;
  /**
   * Whether the reader is seeing prose bodies on tasks. Surfaced so the page can
   * be honest that it is showing a summary rather than the whole thing.
   */
  includeTaskDetail: boolean;
}

/**
 * Resolve a token and build everything the public page shows. One call.
 *
 * Returns `null` for unknown, tampered, revoked and expired tokens alike, and
 * for a link whose target has since been deleted. §16.4 requires exactly that
 * indistinguishability: anything else turns the 404 into an oracle telling a
 * stranger which tokens once existed.
 *
 * **Archived items still resolve.** The owner retired the thinking; they did not
 * revoke the link, and a reader following a URL they were given should see what
 * it points at rather than a 404 they cannot explain. Revocation is the gesture
 * that closes a link, and the view marks the item as archived so the reader
 * knows they are looking at something set aside.
 */
export async function readPublicShare(
  token: string,
  now: Date = new Date()
): Promise<PublicSharePayload | null> {
  const link = await resolveResparkableShareLink(token, now);
  if (!link) return null;

  const access = shareLinkAccess(link);
  const payload = await buildSharePayload(access, link, link.includeChildren, now);
  if (!payload) return null;

  // After the payload, not before: a view of something that could not be
  // rendered is not a view, and counting it would make the owner's "is anyone
  // opening this?" answer include failures.
  await countShareLinkView(link.id, now);

  return payload;
}

/**
 * Build the payload for an already-resolved share.
 *
 * Split out from {@link readPublicShare} because phase 12's named grants land
 * on the same shape from a different basis — the redaction differs, the
 * projection does not.
 */
export async function buildSharePayload(
  access: ResparkableAccessResult,
  ref: { entityType: ResparkableShareableType; entityId: string; includeTaskDetail: boolean },
  includeChildren: boolean,
  now: Date = new Date()
): Promise<PublicSharePayload | null> {
  // Throws rather than returns null on a denial — a caller that reached here
  // without a positive result has a bug, and returning a 404 would hide it.
  const scope = sharedOwnerScope(access);
  const withDetail = !access.redact.includes('notes') && ref.includeTaskDetail;

  const item = await findSharedItem(scope, ref.entityType, ref.entityId, withDetail);
  // The link outlived what it pointed at. Same answer as a bad token, on
  // purpose: the reader learns nothing about whether the item ever existed.
  if (!item) return null;

  if (!includeChildren) {
    return { item, children: [], childrenTruncated: false, includeTaskDetail: withDetail };
  }

  const children = await loadChildren(scope, ref.entityType, ref.entityId, withDetail, now);

  return {
    item,
    children: children.items,
    childrenTruncated: children.truncated,
    includeTaskDetail: withDetail,
  };
}

/**
 * The children of a shared item, by the same rules the cascade uses.
 *
 * A board is asked of `buildBoardView` rather than of the repo, so an explicit
 * board's curated order and a filter board's live membership both come from the
 * one module that owns them. Everything else has a plain FK and comes from
 * `repo/shared-view.ts`.
 *
 * Returns whether the list was cut as well as the list itself. The caller cannot
 * infer it from the length: a page exactly at the limit and a page cut at the
 * limit are the same number, and guessing "more" from that tells readers there
 * is more to see when there is not.
 */
async function loadChildren(
  scope: OwnerScope,
  entityType: ResparkableShareableType,
  entityId: string,
  withDetail: boolean,
  now: Date
): Promise<{ items: SharedItemView[]; truncated: boolean }> {
  if (entityType === 'board') {
    const view = await buildBoardView(scope, entityId, now);
    if (!view) return { items: [], truncated: false };

    // Column order, then card order within a column — the board's own reading
    // order. `unplaced` last, because a card with no column is still a card and
    // silently dropping it would make the shared board disagree with the
    // owner's. Never `priorityScore`: ordering by it leaks the ranking through
    // the sequence even with the number withheld.
    const all = [
      ...view.columns.flatMap((column) => column.cards.map((card) => card.task.id)),
      ...view.unplaced.map((card) => card.task.id),
    ];
    const ids = all.slice(0, SHARED_CHILD_LIMIT);

    const items = await findSharedItems(scope, 'task', ids, withDetail);
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      items: ids
        .map((id) => byId.get(id))
        .filter((item): item is SharedItemView => item !== undefined),
      truncated: all.length > SHARED_CHILD_LIMIT,
    };
  }

  const children = await findSharedChildIds(scope, entityType, entityId);
  if (!children) return { items: [], truncated: false };

  // The query asked for one more than it renders, so a full page here means
  // there is genuinely another one behind it.
  const truncated = children.ids.length > SHARED_CHILD_LIMIT;
  const ids = children.ids.slice(0, SHARED_CHILD_LIMIT);

  const items = await findSharedItems(scope, children.childType, ids, withDetail);
  // Restore the order the id query chose. `findMany` with an `in` makes no
  // ordering promise, and a due-date sequence is the whole point of it.
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    items: ids
      .map((id) => byId.get(id))
      .filter((item): item is SharedItemView => item !== undefined),
    truncated,
  };
}

/** Re-exported so routes do not each import from two modules. */
export type { LiveShareLink, SharedItemView };
