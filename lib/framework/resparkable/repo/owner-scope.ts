/**
 * `OwnerScope` — the type that makes D5 structural rather than a convention.
 *
 * **Every brain query is either an owner query or a shared query. There is no
 * third kind.** Owner queries are `WHERE userId = $1` with no joins and no
 * resolution; shared queries opt in explicitly and go through
 * `lib/framework/resparkable/access/*` (Release 2). The repo layer takes an
 * `OwnerScope` and **cannot express a cross-user read** — that is the whole
 * point, and it is adopted now, before sharing or sync exist, because
 * retrofitting it is what causes leaks (plan D5).
 *
 * Three things enforce it, in decreasing order of strength:
 *
 *   1. Every repo function's first parameter is an `OwnerScope`, and every
 *      `where` clause it builds spreads `ownerWhere(scope)`. There is no repo
 *      function that takes a bare `userId` string, so "I forgot the filter" is
 *      not a reachable state.
 *   2. `OwnerScope` is a branded type. A `string` — a route param, a request
 *      body field, an LLM tool argument — does not satisfy it. The only way to
 *      get one is `ownerScope(session.user.id)`, at a call site where a human
 *      reviewer can see where the id came from.
 *   3. An ESLint boundary in `lib/framework/eslint.config.mjs` forbids
 *      `repo/**` from importing `access/**`, and forbids everything in the tier
 *      *except* `repo/**` from importing the Prisma client at all.
 *
 * The brand is the load-bearing part. Without it this is a naming convention,
 * and `getTask(req.body.userId, id)` type-checks.
 */

/** Unique symbol tag — never exported, never constructible outside this file. */
declare const ownerScopeBrand: unique symbol;

/**
 * A verified owner identity. Obtainable only from `ownerScope()`.
 *
 * Carrying a scope object rather than a raw id also leaves room for the fields
 * a later release needs (an impersonating admin, a tenant) without touching
 * every repo signature again.
 */
export interface OwnerScope {
  readonly userId: string;
  readonly [ownerScopeBrand]: true;
}

/**
 * The `CapabilityContext.scope` key that carries a scheduled run's owner.
 *
 * **Why a scope key rather than `execution.userId`.** Until Resparkable 0.8.0 the
 * scheduler stamped `execution.userId = schedule.createdBy`, so a background run
 * arrived already owned. resparkable#502 made scheduled runs **system-owned**
 * (`userId: null`) — deliberately, because `AiWorkflowExecution.userId` is
 * `onDelete: Cascade` and naming an operator meant erasing them destroyed the
 * organisation's whole scheduled-run history. That reasoning is right for the
 * org-level cron rows core has in mind, and it removes the only mechanism
 * Resparkable's **per-user** schedules had for saying whose brain a 04:30 run is.
 *
 * `AiWorkflowSchedule.scope` is the seam core points forks at for exactly this:
 * a `Json?` column, admin-written, validated on read by `resolvePersistedScope`,
 * stamped onto `AiWorkflowExecution.scope` and threaded into
 * `CapabilityContext.scope` — with core naming no keys and reading none. It is
 * **not** reachable from a model: no `agent*Schema` has a `scope` field, and
 * `.strict()` makes an attempt to add one a validation error.
 *
 * The residue this leaves is bounded by design. The id sits on a row that
 * outlives the account (`createdBy` is `SetNull`), but Resparkable's erasure hook
 * deletes that user's schedule rows outright, and the connection sweep
 * independently deletes any Resparkable schedule whose `createdBy` is null — so the
 * same backstop that already covered `createdBy` covers this.
 *
 * Filed upstream as resparkable#532; ask #29 in
 * `.context/framework/resparkable/sunrise-asks.md`.
 */
export const RESPARKABLE_SCHEDULE_OWNER_KEY = 'resparkableUserId';

/**
 * The same thing, under the name §24.2 says it has to have.
 *
 * `resparkableUserId` stops being able to answer the question the moment one
 * person can own several workspaces: a per-user key cannot name which of three
 * brains a 04:30 run is for. Phase 45 lands the rename with the rest of the key
 * migration, because rewriting a `Json?` column is cheap while every user has
 * exactly one space and the mapping is the identity, and it is a data-repair job
 * with a support tail afterwards.
 *
 * **Both keys are written, and either is read.** Replacing the old one outright
 * opens a window at deploy, before the new code is on every pod, in which an old
 * reader finds nothing and silently resolves no owner: a skipped bill, or a 04:30
 * briefing in which every capability throws with nothing surfacing it. Keeping
 * both makes a pre-migration row resolve without a special case and leaves a
 * one-line deletion for a later phase. Read through
 * {@link readResparkableScheduleSpaceId} rather than either constant directly,
 * so the fallback lives in one place.
 */
export const RESPARKABLE_SCHEDULE_SPACE_KEY = 'resparkableSpaceId';

/**
 * Pull the space id out of a persisted scope, accepting either key.
 *
 * Returns `undefined` rather than throwing: a scope naming no space is an
 * ordinary state (an org-level schedule that has nothing to do with this tier),
 * and the callers already have a "no owner" path that says so properly.
 */
export function readResparkableScheduleSpaceId(
  scope: Record<string, unknown> | null | undefined
): string | undefined {
  if (!scope) return undefined;
  const next = scope[RESPARKABLE_SCHEDULE_SPACE_KEY];
  if (typeof next === 'string' && next.length > 0) return next;
  const legacy = scope[RESPARKABLE_SCHEDULE_OWNER_KEY];
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

/**
 * Mint a scope from a **verified** user id.
 *
 * The id must come from the session (`withAuth`'s `session.user.id`), from
 * `CapabilityContext.userId` (which the engine populates from the session or the
 * MCP API key's owner), from `CapabilityContext.scope`'s
 * {@link RESPARKABLE_SCHEDULE_OWNER_KEY} on a scheduled run, or — since Release 2
 * — from a **positive** `ResparkableAccessResult` via `sharedOwnerScope()`
 * (`lib/framework/resparkable/access/resolve.ts`). Never from a request body, a
 * route param, a vault file's `resparkable-id`, or an LLM-supplied tool
 * argument. Those are the four documented ways a user id gets
 * attacker-influenced (plan §17 risks 6d, 8, 9).
 *
 * The fourth source is the one that reads a stranger's request and still
 * produces an owner identity, so it is worth naming what makes it different in
 * kind rather than in degree: the caller supplies a token, and the **database**
 * answers who owns the item. The id never travelled through the request. What
 * the resulting scope buys is narrowed on the other side, by the allowlisted
 * projection in `repo/shared-view.ts`.
 *
 * This function cannot check that for you. What it can do is make every place
 * a scope is created greppable: `rg 'ownerScope\('` is the complete list of
 * trust boundaries in the brain, and it should stay short enough to read.
 */
export function ownerScope(userId: string): OwnerScope {
  if (typeof userId !== 'string' || userId.length === 0) {
    // A falsy scope would build `WHERE userId = ''`, which matches nothing —
    // so this would fail as an empty list rather than a leak. It still throws:
    // silently returning nothing turns an auth bug into "the page is blank",
    // which is a bug report that takes a day to trace.
    throw new Error('ownerScope: a non-empty verified userId is required');
  }
  // The brand is a phantom property with no runtime representation, so the
  // literal cannot satisfy `OwnerScope` structurally — this assertion is the
  // one place the brand is applied, which is exactly why it lives here and
  // nowhere else.
  const scope = { userId };
  return scope as OwnerScope;
}

/**
 * The mandatory filter fragment.
 *
 * **In a `where`, spread it first and follow it only with literal keys** —
 * that reads as "scoped, then filtered", and is what every repo here does:
 *
 *   where: { ...ownerWhere(scope), status: 'todo' }   // correct
 *
 * **In `data`, spread it LAST**, because the last spread wins and the scope
 * must beat anything the caller sent:
 *
 *   data: { ...input, ...ownerWhere(scope) }          // correct — scope wins
 *
 * The rule is therefore "the scope is the spread that wins", not a fixed
 * position. Never spread a caller-supplied object *after* `ownerWhere` in a
 * `where` — `{ ...ownerWhere(scope), ...filters }` lets a `userId` key in
 * `filters` replace the scope, which is precisely the leak this type exists to
 * prevent. (No repo does this today; the `WithoutOwner` type and the `.strict()`
 * route schemas are the two other things standing in the way.)
 */
export function ownerWhere(scope: OwnerScope): { userId: string } {
  return { userId: scope.userId };
}

/**
 * How much of the archive a query sees.
 *
 * `false` (the default everywhere) hides it, `true` mixes archived rows in with
 * live ones, and `'only'` returns the archive alone. The third exists because
 * "show me my archive" is a different question from "include archived", and
 * answering it with `true` gives a list where the archived items are buried
 * among everything still live — which is not an archive view, it is a longer
 * list (§11 asks for the former).
 */
export type ArchiveVisibility = boolean | 'only';

/**
 * Owner filter plus the archived-item exclusion, for the models that have one.
 *
 * **Every default query gains `archivedAt: null`** and it belongs here rather
 * than at each call site — the plan is explicit that scattering it is how one
 * list eventually forgets and starts showing a user their own archive (§11).
 *
 * @param includeArchived - Opt in explicitly. Only the archived-list views,
 *   `GET /resparkable/search?includeArchived=true` and the retention pass should
 *   ever pass anything but `false`.
 */
export function liveOwnerWhere(
  scope: OwnerScope,
  includeArchived: ArchiveVisibility = false
): { userId: string; archivedAt?: null | { not: null } } {
  if (includeArchived === 'only') {
    return { userId: scope.userId, archivedAt: { not: null } };
  }
  return includeArchived ? { userId: scope.userId } : { userId: scope.userId, archivedAt: null };
}
