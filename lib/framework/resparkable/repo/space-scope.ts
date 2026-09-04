/**
 * `SpaceScope`: the type that makes D5 structural rather than a convention.
 *
 * **Every brain query is either a space query or a shared query. There is no
 * third kind.** Space queries are `WHERE spaceId = $1` with no joins and no
 * resolution; shared queries opt in explicitly and go through
 * `lib/framework/resparkable/access/*` (Release 2). The repo layer takes a
 * `SpaceScope` and **cannot express a cross-space read**, which is the whole
 * point, and it was adopted before sharing or sync existed because retrofitting
 * it is what causes leaks (plan D5).
 *
 * Three things enforce it, in decreasing order of strength:
 *
 *   1. Every repo function's first parameter is a `SpaceScope`, and every
 *      `where` clause it builds spreads `spaceWhere(scope)`. There is no repo
 *      function that takes a bare id string, so "I forgot the filter" is not a
 *      reachable state.
 *   2. `SpaceScope` is a branded type. A `string`, whether a route param, a
 *      request body field or an LLM tool argument, does not satisfy it. The only
 *      way to get one is a constructor in this file, at a call site where a
 *      human reviewer can see where the id came from.
 *   3. An ESLint boundary in `lib/framework/eslint.config.mjs` forbids
 *      `repo/**` from importing `access/**`, and forbids everything in the tier
 *      *except* `repo/**` from importing the Prisma client at all.
 *
 * The brand is the load-bearing part. Without it this is a naming convention,
 * and `getTask(req.body.userId, id)` type-checks.
 *
 * ## What phase 45 changed, and what it deliberately did not
 *
 * This was `OwnerScope { userId }` until Release 9 (`plan.md` §23.2). The type
 * was built for the change: its own comment said carrying a scope object rather
 * than a raw id "leaves room for the fields a later release needs (an
 * impersonating admin, a tenant) without touching every repo signature again".
 * That room is now spent.
 *
 * The partition key and the acting person are now separate fields, and the
 * separation is the entire point. **`actorUserId` is never a query filter
 * anywhere in `repo/**`.** The moment it is, a group space has a per-row ACL:
 * a membership join on the hot path of roughly forty list endpoints,
 * `priorityScore`'s single indexed `ORDER BY` defeated, and every one of those
 * endpoints a potential leak (§23.4). It is there for attribution and for role
 * checks at the boundary, and `repo/isolation.test.ts` asserts by enumeration
 * that no repo query mentions it.
 *
 * Membership resolves **once**, where a scope is minted, and never again inside
 * a query. `rg 'spaceScope\(|spaceScopeFor\('` is the complete list of trust
 * boundaries in the brain, and it should stay short enough to read.
 */

/** Unique symbol tag: never exported, never constructible outside this file. */
declare const spaceScopeBrand: unique symbol;

/**
 * Who an actor is inside a space.
 *
 * Four values, and **no space uses all four.** `owner` is the personal-space
 * role: the sole actor on a space with `ownerUserId` set, holding every
 * permission. `admin | member | viewer` are the group roles (§23.3). One union
 * rather than two types, because every call site that checks a role is asking
 * "may this actor write here" and would otherwise have to branch on space kind
 * first, which is the branch that eventually gets forgotten.
 *
 * The invariant worth asserting is the exclusion rather than the count:
 * **`owner` never appears on a `kind: 'group'` space.** §23.2 states it the
 * other way round as well, that a personal space is always `owner`, and that
 * half is not true and never was: `access/**` has minted scopes on other
 * people's personal spaces since Release 2, and those are viewers.
 *
 * Nothing branches on this yet. It is here so phase 46 adds group membership
 * without touching 207 repo signatures a second time.
 */
export type SpaceRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * A verified space identity. Obtainable only from the constructors below.
 */
export interface SpaceScope {
  /** The partition key: what every `WHERE` in `repo/**` uses. */
  readonly spaceId: string;
  /**
   * Who is acting. Attribution and role checks, **never a filter**.
   *
   * Nullable because an anonymous public-link reader has no account
   * (`ResparkableViewer.userId` is `string | null` for the same reason). The
   * null can never reach a `WHERE`, because nothing about this field ever does.
   */
  readonly actorUserId: string | null;
  readonly role: SpaceRole;
  readonly [spaceScopeBrand]: true;
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
 *
 * **The name says `SCHEDULE` and the key is not only a schedule's** (phase 47).
 * A schedule row was the first carrier and is where the name comes from; the
 * chat route now writes the same key onto `ChatRequest.scope` so a turn's tools
 * read the workspace the turn is about. The constant keeps its name rather than
 * gaining a synonym: one spelling of a wire value is worth more than an
 * accurate variable name, and two names for one string is how a carrier ends up
 * half-migrated.
 *
 * The two carriers are read differently and deliberately so. A schedule's scope
 * is admin-written and there is no actor to check it against, so it is the
 * authority. A chat request's is a hint core routes through `hintScope`, and
 * `requireResparkableSpace` re-resolves it against membership. `capabilities/
 * base.ts` is where that split is spelled out.
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
 * a scope is created greppable: `rg 'spaceScope\(|spaceScopeFor\('` is the
 * complete list of trust boundaries in the brain, and it should stay short
 * enough to read.
 *
 * ## Why this still takes one string
 *
 * A personal space's key value IS its owner's user id (§23.2), so this
 * constructor takes the id and fills in the rest: the actor is the owner, and
 * the role is `owner`. It could have taken the three fields and made all ~85
 * call sites say so. It does not, and that is deliberate: phase 45 is meant to
 * change no behaviour, and an 85-site signature change is where a behaviour
 * change hides. Sites that gain a real choice get {@link spaceScopeFor}, in the
 * phase that gives them one.
 */
export function spaceScope(userId: string): SpaceScope {
  if (typeof userId !== 'string' || userId.length === 0) {
    // A falsy scope would build `WHERE spaceId = ''`, which matches nothing, so
    // this would fail as an empty list rather than as a leak. It still throws:
    // silently returning nothing turns an auth bug into "the page is blank",
    // which is a bug report that takes a day to trace.
    throw new Error('spaceScope: a non-empty verified userId is required');
  }
  // The brand is a phantom property with no runtime representation, so the
  // literal cannot satisfy `SpaceScope` structurally. This assertion is the one
  // place the brand is applied, which is exactly why it lives here and nowhere
  // else.
  const scope = { spaceId: userId, actorUserId: userId, role: 'owner' as const };
  return scope as SpaceScope;
}

/**
 * Mint a scope for an actor who is not the space's owner.
 *
 * The second and last constructor. Two callers today, both in `access/**`,
 * where a grantee reads somebody else's personal space; phase 46 adds the group
 * ones. Everything else uses {@link spaceScope}.
 *
 * Refuses `owner` without an actor, because `owner` means "the sole human who
 * owns this space" and an anonymous public-link reader is not that. The reverse
 * pairing is fine and is how a public link resolves: a `viewer` with no actor.
 */
export function spaceScopeFor(input: {
  spaceId: string;
  actorUserId: string | null;
  role: SpaceRole;
}): SpaceScope {
  if (typeof input.spaceId !== 'string' || input.spaceId.length === 0) {
    throw new Error('spaceScopeFor: a non-empty verified spaceId is required');
  }
  if (input.role === 'owner' && !input.actorUserId) {
    throw new Error('spaceScopeFor: the owner role requires a named actor');
  }
  const scope = {
    spaceId: input.spaceId,
    actorUserId: input.actorUserId,
    role: input.role,
  };
  return scope as SpaceScope;
}

/**
 * The mandatory filter fragment.
 *
 * **In a `where`, spread it first and follow it only with literal keys.** That
 * reads as "scoped, then filtered", and is what every repo here does:
 *
 *   where: { ...spaceWhere(scope), status: 'todo' }   // correct
 *
 * **In `data`, spread it LAST**, because the last spread wins and the scope
 * must beat anything the caller sent:
 *
 *   data: { ...input, ...spaceWhere(scope) }          // correct: scope wins
 *
 * The rule is therefore "the scope is the spread that wins", not a fixed
 * position. Never spread a caller-supplied object *after* `spaceWhere` in a
 * `where`: `{ ...spaceWhere(scope), ...filters }` lets a key in `filters`
 * replace the scope, which is precisely the leak this type exists to prevent.
 * (No repo does this today; the `WithoutOwner` type and the `.strict()` route
 * schemas are the two other things standing in the way.)
 *
 * The field and the column agree again. For one commit they did not: phase 45
 * renamed the column, mapped the Prisma field onto it, and renamed the field
 * separately, so that the irreversible change carried no code and the churny one
 * carried no SQL. This function was the seam that made those two separable, and
 * this line is what changed when the field caught up.
 */
export function spaceWhere(scope: SpaceScope): { spaceId: string } {
  return { spaceId: scope.spaceId };
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
 * Space filter plus the archived-item exclusion, for the models that have one.
 *
 * **Every default query gains `archivedAt: null`** and it belongs here rather
 * than at each call site — the plan is explicit that scattering it is how one
 * list eventually forgets and starts showing a user their own archive (§11).
 *
 * @param includeArchived - Opt in explicitly. Only the archived-list views,
 *   `GET /resparkable/search?includeArchived=true` and the retention pass should
 *   ever pass anything but `false`.
 */
export function liveSpaceWhere(
  scope: SpaceScope,
  includeArchived: ArchiveVisibility = false
): { spaceId: string; archivedAt?: null | { not: null } } {
  if (includeArchived === 'only') {
    return { ...spaceWhere(scope), archivedAt: { not: null } };
  }
  return includeArchived ? spaceWhere(scope) : { ...spaceWhere(scope), archivedAt: null };
}
