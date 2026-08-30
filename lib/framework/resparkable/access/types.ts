/**
 * The vocabulary of Resparkable's sharing layer (Release 2, §13).
 *
 * Types only, no I/O, so the shapes can be read in one sitting and asserted
 * against without standing up a database. Everything that touches Postgres is
 * in `store.ts`; everything that decides is in `resolve.ts`.
 *
 * ## The one rule this file encodes
 *
 * **A brain query is either an owner query or a shared query, and there is no
 * third kind (D5).** `repo/**` answers the first: every function takes an
 * `SpaceScope`, spreads it into the `where`, and cannot express a cross-user
 * read. This directory answers the second, and an ESLint boundary
 * (`lib/framework/eslint.config.mjs`) forbids `repo/**` from importing it — so
 * the separation is structural rather than a naming convention.
 */

/**
 * The six shareable types, and the narrowing guard.
 *
 * **Declared in `validations.ts`, re-exported here.** It is vocabulary rather
 * than resolution, and `repo/**` needs the union to type a column — while the
 * ESLint boundary rightly forbids the repo layer from importing this directory
 * at all. Re-exporting means the sharing code reads as though it owns its own
 * words while the boundary stays strict.
 *
 * `thought` is deliberately absent; see the declaration for why that is a
 * feature rather than a gap, and why `task` was put back on the list.
 */
import {
  RESPARKABLE_SHAREABLE_TYPES,
  isResparkableShareableType,
  type ResparkableShareableType,
} from '@/lib/framework/resparkable/validations';

export { RESPARKABLE_SHAREABLE_TYPES, isResparkableShareableType };
export type { ResparkableShareableType };

/** One item, addressed the way every row in this layer addresses one. */
export interface ResparkableEntityRef {
  entityType: ResparkableShareableType;
  entityId: string;
}

/** `type:id`, the key both maps in this layer are keyed by. */
export function refKey(ref: ResparkableEntityRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

/**
 * Who is asking.
 *
 * **There is no `linkToken` field, on purpose.** A public link is resolved by
 * its own entry point (`resolveResparkableShareLink`), never by presenting a
 * token alongside a session. That is what makes "a public link grants no access
 * to the authenticated route" (§16.4) structurally true rather than a rule
 * somebody has to remember at twenty call sites.
 *
 * Both fields may be null — that is an anonymous viewer, who resolves to a
 * denial through this path and reaches content only through a share link.
 */
export interface ResparkableViewer {
  /** From the session. Never from a request body or a route param. */
  userId: string | null;
  /**
   * Lower-cased. A grant is addressed by email until it is accepted, so a
   * viewer whose account exists but whose grant has never been opened is found
   * by this and not by `userId`.
   */
  email: string | null;
}

/**
 * Why access was granted.
 *
 * The distinction between direct and cascaded is not cosmetic, but it is
 * narrower than it sounds, and this comment used to overstate it. **A cascaded
 * item carries the same redaction set as a direct one of the same kind.** What
 * changes is two things: `permissions.comment` is always false, because
 * commenting is something you do to the item that was actually handed over; and
 * `via` names the parent, so the UI can say "shared as part of X" rather than
 * presenting it as a thing someone chose to give you.
 *
 * Redaction does not change because the cascade only ever runs inside one
 * brain the viewer was already given a door into. A grantee who can see the
 * project can already see who shared it and what was said about it; withholding
 * the same two fields one level down would read as a bug rather than as care,
 * and would leave a grantee looking at comments on a project and none on its
 * tasks. The line that does the work is basis-kind, `grant` versus `link`: a
 * named grant is a relationship and carries `ownerIdentity` and `comments`, a
 * public link is a document and carries neither.
 */
export type ResparkableAccessBasis = 'owner' | 'grant' | 'grant-cascade' | 'link' | 'link-cascade';

/** What the caller is trying to do. `comment` implies `read`. */
export type ResparkableNeed = 'read' | 'comment';

/**
 * A field a caller MUST strip before serialising.
 *
 * A list rather than a boolean per field so a new redaction cannot be added
 * without every serialiser seeing an unfamiliar member — the compiler will not
 * catch a forgotten `if`, but a reviewer reading `redact` against a serialiser
 * can.
 *
 * `'links'` is the subtle one. Links from a shared item to a non-shared item
 * are **omitted entirely, not rendered redacted**: "Project X blocks
 * [redacted]" is itself a leak — it discloses that a hidden thing exists, is
 * blocked, and is related to this.
 */
export type ResparkableRedaction =
  | 'notes'
  | 'priorityScore'
  | 'manualBoostReason'
  | 'ownerIdentity'
  | 'comments'
  | 'links'
  | 'events'
  | 'parent';

/**
 * Everything a shared read must hide.
 *
 * The baseline, from which a basis subtracts. Starting from "hide everything
 * interesting" and opening specific fields is the direction that fails safe: a
 * field added to a model tomorrow is not in any allowance, so it stays hidden
 * until somebody decides otherwise.
 */
export const ALL_REDACTIONS: readonly ResparkableRedaction[] = [
  'notes',
  'priorityScore',
  'manualBoostReason',
  'ownerIdentity',
  'comments',
  'links',
  'events',
  'parent',
];

/**
 * The answer, and everything a caller needs to act on it without a second query.
 *
 * `ownerId` is `null` on every denial — including when the item exists and
 * belongs to someone else. Returning it would be a user-enumeration vector, and
 * the route's answer is a 404 either way: **not-found and not-yours are the
 * same answer**, which is the rule the whole repo layer already follows.
 */
export interface ResparkableAccessResult {
  ok: boolean;
  basis: ResparkableAccessBasis | null;
  ownerId: string | null;
  permissions: { read: boolean; comment: boolean };
  redact: readonly ResparkableRedaction[];
  /**
   * The item the grant or link was actually made on, when access came through a
   * cascade. `null` for a direct basis. The UI needs it to say "shared as part
   * of Acme Redesign" instead of implying the child was handed over on its own.
   */
  via: ResparkableEntityRef | null;
}

/** The single denial value. Frozen, so a caller cannot mutate the shared object. */
export const DENY: ResparkableAccessResult = Object.freeze({
  ok: false,
  basis: null,
  ownerId: null,
  permissions: Object.freeze({ read: false, comment: false }),
  redact: ALL_REDACTIONS,
  via: null,
});

/** A live grant, as the access layer reads it. */
export interface LiveGrant {
  id: string;
  ownerId: string;
  entityType: ResparkableShareableType;
  entityId: string;
  role: 'viewer' | 'commenter';
  includeTaskDetail: boolean;
  acceptedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /**
   * When the owner shared this.
   *
   * Carried for the grantee's surface, which has to be able to say "Priya
   * shared this on Tuesday" — `acceptedAt` cannot stand in for it, because a
   * grant to an address that already has an account is live from the moment it
   * is issued and may never be accepted at all.
   */
  createdAt: Date;
}

/** A live public link, as the access layer reads it. */
export interface LiveShareLink {
  id: string;
  ownerId: string;
  entityType: ResparkableShareableType;
  entityId: string;
  includeChildren: boolean;
  includeTaskDetail: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * What one viewer can currently see, resolved once.
 *
 * The bulk form of the question `resolveResparkableAccess` answers per item.
 * `/shared-with-me` builds one of these and lists from it; a route resolving
 * twenty items builds one and never queries the grant table again.
 *
 * **Not cached beyond a request.** Revocation has to be immediate — a grantee
 * who has been cut off must 404 on their *next* request, not after a TTL — and
 * a shared cache is how "I revoked that an hour ago" becomes untrue.
 */
export interface ResparkableVisibilityScope {
  readonly viewer: ResparkableViewer;
  /** Every live grant this viewer holds. Empty for an anonymous viewer. */
  readonly grants: readonly LiveGrant[];
  /** Directly-granted ids per type — what `/shared-with-me` enumerates. */
  readonly directRefsByType: ReadonlyMap<ResparkableShareableType, readonly string[]>;
}
