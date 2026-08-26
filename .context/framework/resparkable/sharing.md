# Sharing — the access layer

How Resparkable answers **"may this viewer see this row?"**, and why the answer lives where it does.

This is the Release 2 companion to [`plan.md`](./plan.md) §13, which is the specification. This document is what a person reading the code needs: the boundary, the entry points, what each basis permits, and the four places the implementation deviates from the plan on purpose.

Status: **phase 10 landed** (access resolution, the two tables, the ESLint boundary). Phases 11–14 — public-link routes and the reader, named-grant routes and `/shared-with-me`, invites and comments, the erasure hooks — are still to come.

---

## The one rule

> Every brain query is either an **owner query** or a **shared query**. There is no third kind.

That is decision D5, and after phase 10 it is two directories rather than one rule:

| Layer                                 | Answers        | Takes        | Can it cross a user?                |
| ------------------------------------- | -------------- | ------------ | ----------------------------------- |
| `lib/framework/resparkable/repo/**`   | owner queries  | `OwnerScope` | **No** — not expressible            |
| `lib/framework/resparkable/access/**` | shared queries | a viewer     | Only by following a grant or a link |

Everything else in the tier — services, routes, capabilities, workflows — goes through one of the two and cannot reach Prisma at all. Three things hold that up, in decreasing order of strength:

1. **`OwnerScope` is a branded type.** A route param, a request body field or an LLM tool argument does not satisfy it. `rg 'ownerScope\('` is the complete list of trust boundaries in the brain.
2. **ESLint.** `lib/framework/eslint.config.mjs` bans `@/lib/db/client` everywhere in the tier except those two directories, and separately bans `repo/**` from importing `access/**` — so the two cannot collapse back into one layer that does both. Run as behaviour, not read as config: `tests/unit/lib/framework/resparkable/access/eslint-d5-boundary.test.ts` pulls the real rule entries out of the shipped file and lints fixtures through them.
3. **Naming.** Every function in `access/store.ts` is named for the grant or link it follows.

---

## The two tables

Two orthogonal facts, deliberately not merged.

**`visibility` on the entity** (`private | link`) is **only** about the public-link surface. It is never a filter on an owner read — the owner's own agent sees all of the owner's items regardless of it — and keeping it off the hot path is why the resolver short-circuits before anything looks at it.

**Named grants live entirely in `ResparkableGrant` rows.** Nothing is denormalised onto the entity or its children. See "the cascade" below for why.

| Table                              | Holds                                         | Key details                                                                                  |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `framework_resparkable_grant`      | One person, one item, `viewer` or `commenter` | `userId` is the **owner**. Grantee is `granteeUserId` (null until accepted) + `granteeEmail` |
| `framework_resparkable_share_link` | A public read-only link                       | `tokenHash` is sha256 of a 192-bit `base64url` token. The plaintext is never stored          |

### Two things about these tables that are easy to get wrong

**`userId` is the owner, not the grantee.** That is what preserves D1: the row cascades from `ResparkableSpace` like every other table in the tier, and `WHERE userId = $1` means the same thing here as everywhere else. Reading this table _by grantee_ is the one thing `repo/**` must never do.

**The grantee needs its own foreign key, and it is hand-written.** Nothing cascades to a grant row when the **grantee** is erased, because `userId` is the owner. `ON DELETE SET NULL` would be worse than no constraint at all: it leaves a live grant addressed by `granteeEmail` — retained personal data belonging to an erased person, on a row they cannot reach. So `framework_resparkable_grant_granteeUserId_fkey` is `ON DELETE CASCADE`, written by hand in the migration because `User` lives in a Sunrise-owned file, and guarded by **drift probe B8** (the sibling of B1, which guards the owner cascade).

That FK covers accepted grants. **Unaccepted invites have no `granteeUserId` to hang off**, and are covered by an erasure `scrubInTransaction` hook matching `granteeEmail` — phase 14. Both halves are needed; neither covers the other.

### Why the token is hashed

`AiAgentEmbedToken` and `AiAgentInviteToken` store plaintext cuids. That is fine for admin-issued, deployment-scoped tokens. A brain share link is a bearer credential to a private person's life: a database dump or a log leak must not hand over every user's notes.

Mint with `randomBytes(24).toString('base64url')` — 192 bits, and deliberately **not** a cuid. Cuids are timestamp-prefixed and monotonic, precisely the wrong shape for "unguessable".

---

## Entry points

```ts
resolveResparkableAccess({ viewer, entityType, entityId, need }); // one item
resolveResparkableAccessMany({ viewer, refs, need }); // a list
resparkableVisibilityScope(viewer); // "what is shared with me"

resolveResparkableShareLink(token); // the public reader
shareLinkAccess(link);
resolveResparkableShareLinkChild(link, child);
```

All from `@/lib/framework/resparkable/access`. Routes import the barrel; nothing outside the directory reaches into `store.ts`.

### The owner short-circuit

Almost every call is someone reading their own brain. That path is **one indexed lookup of a single column** and then a string comparison — no grant query, no link query, no cascade.

It is not only about speed. Short-circuiting before anything consults `visibility` is what makes "the owner's own agent sees all of the owner's items" structurally true rather than a comment somebody later contradicts by adding `visibility: 'private'` to an agent query.

### Query cost

| Call                           | Queries                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Owner reading their own item   | 1                                                                                 |
| Grantee, direct grant          | 2                                                                                 |
| Grantee, cascaded              | 3–5 (skipped entirely for types with no parent type)                              |
| `resolveResparkableAccessMany` | **4, whatever the list size** — owners, direct grants, cascade parents, inherited |

The batched form is not an optimisation, it is a requirement. `task` is the highest-cardinality shareable type and a shared board is a list of them; a per-row resolver would make a fifty-card board a two-hundred-query page load. That cost is what §13 explicitly accepted when it reversed its earlier decision and put `task` back on the shareable list.

### Two things `resolveResparkableAccess` deliberately does not do

**It never consults a share link.** `ResparkableViewer` has no token field, so there is nothing for it to consult — which is how "a public link grants no access to the authenticated route" stays true without twenty routes remembering a rule. The public reader uses `resolveResparkableShareLink`.

**It is not cached beyond a request.** Revocation must be immediate: a grantee who has been cut off 404s on their _next_ request, not after a TTL.

---

## What each basis permits

`redact` is a list of field names the caller **must** strip before serialising. It is computed as _what a basis removes from `ALL_REDACTIONS`_, never as what it allows — so a redaction added tomorrow applies to every basis until somebody decides otherwise. Failing closed on a field nobody has thought about yet is the only safe default.

| Basis           | Reads | Comments | Sees owner identity | Sees `notes`                |
| --------------- | ----- | -------- | ------------------- | --------------------------- |
| `owner`         | ✅    | ✅       | (their own)         | ✅ — nothing is redacted    |
| `grant`         | ✅    | ✅\*     | ✅                  | only if `includeTaskDetail` |
| `grant-cascade` | ✅    | ❌       | ✅                  | only if `includeTaskDetail` |
| `link`          | ✅    | ❌       | ❌                  | only if `includeTaskDetail` |
| `link-cascade`  | ✅    | ❌       | ❌                  | only if `includeTaskDetail` |

\* `role: 'commenter'` only.

Nobody but the owner ever sees `priorityScore`, `manualBoostReason`, the event history, or the parent an item hangs off.

**The line between a link and a grant is the product's own: a public link is a _document_, a named grant is a _relationship_.** A stranger holding a URL gets the content and nothing about the person. Someone the owner named gets to know who shared it and to say something back.

**A cascaded item cannot be commented on, even with a commenter grant on its parent.** It was never chosen for sharing by its owner; commenting is something you do to the thing that was actually handed over.

### `links` is the subtle redaction

Links from a shared item to a non-shared item are **omitted entirely, not rendered redacted**. "Project X blocks [redacted]" is itself a leak: it discloses that a hidden thing exists, is blocked, and is related to this one.

---

## The cascade

Computed at read time from the parent grant, **never denormalised into child rows**. Denormalising would mean every task insert and every task move had to fix up grant rows — and a missed fix-up is a leak: a task dragged out of a shared project that keeps its inherited grant is a document still being handed to someone the owner stopped sharing with, with nothing anywhere saying so.

```
project → its tasks
goal    → its child goals
board   → its cards' tasks   (explicit membership AND filter membership)
area    → nothing automatically
review  → nothing
task    → nothing
```

Declared as data (`RESPARKABLE_CASCADE` in `access/cascade.ts`), so the whole cascade is one thing to read and a test can assert its shape directly rather than probing for absences one call at a time.

**Sharing a project DOES include its tasks.** A project without its tasks is a title and a paragraph, and people work around that by pasting task lists into descriptions — strictly worse, because a paste goes stale, carries no redaction, and is invisible to revocation.

### The dynamic-filter trap

A board with `membership: 'filter'` is a live query. Sharing it does not share a fixed set of cards — it shares **every task matching the filter, including ones created later**. That is what people expect from "share my board", and it is also a standing leak: a task created next Tuesday that happens to match becomes visible to that grantee with no further action from the owner.

The code implements this faithfully rather than quietly narrowing it, and `resolve.test.ts` asserts it directly so it can never become an accident. Three mitigations belong in the share dialog, all required:

- **State the filter in plain English** — "Anyone with this link sees tasks matching: project = Acme Redesign, status is not done. This includes tasks you add later."
- **Show a live count** of currently-matching tasks before confirming.
- **Offer "share a snapshot instead"**, which flips the board to `membership: 'explicit'` and materialises today's matches. For anything leaving your organisation this is the safer choice, and the UI should say so.

An explicit-membership board has no such problem: its contents are exactly the rows you put in it.

---

## Four deliberate deviations from the plan

Recorded here rather than quietly diverging.

**1. There is no `goal → project` cascade.** §13 describes the goal cascade as reaching "child goals and projects (and their tasks)". The schema has no such edge: a `ResparkableProject` hangs off an `areaId`, and its relationship to a goal is a user-authored `ResparkableLink` row. Following links would make the cascade transitive _and_ user-editable, which is exactly what "one level and typed" forbids; inventing an FK would change the data model to fit a cascade rule. So the goal cascade reaches child goals, and a project is shared by sharing the project.

**2. The ESLint boundary lives in `lib/framework/eslint.config.mjs`, not `lib/app/`.** The plan named the leaf-tier config. The framework tier is the right home: the rule is about framework-tier paths, and putting it in the leaf tier would mean every fork inherited a rule about a directory it does not own.

**3. `access/**` may import Prisma.** The plan's phrasing ("the repo layer is the only place that talks to the database") predates the shared-query layer existing. Routing shared queries through `repo/**` would mean giving that layer a way to say "not my rows" — precisely the capability it exists not to have. The boundary is not "one layer touches the database"; it is "each layer is named for the kind of query it may write".

**4. `boardFilterMatches` fails closed where `loadFilteredCards` fails open.** When a board's stored `filter` JSON does not parse, the render path (`services/board-view.ts`) falls back to an empty filter and shows everything live. Doing the same in the access layer would be fail-open in an authorisation path — a corrupt column would widen a shared board to the owner's entire task list. So it denies, and the resulting mismatch runs in the safe direction: the grantee sees fewer cards than the owner, never more.

---

## Shared-in items get their own surface

They do **not** appear in the viewer's own lists or search. Three reasons, in weight order:

1. It preserves `WHERE userId = $1` as an unconditional invariant on every list, search and embedding query in the tier.
2. A second brain's lists are a **planning** surface. Someone else's project sitting in "my projects" corrupts prioritisation and your own sense of what you have committed to.
3. Mixing them in would make ~40 list endpoints potential leaks, rather than the ~6 that have to be got right.

`/shared-with-me` (phase 12) gets its own routes under `/api/v1/resparkable/shared/*`, its own search that explicitly does **not** touch `ResparkableEmbedding`, and no write paths.

**Shared-in items are excluded from everything of the owner's** — embeddings, context, prioritisation, background workflows. No exceptions. The subtle failure is a naive union of cascaded tasks, which both corrupts "what should I do now" and leaks another person's deadlines into an LLM prompt.

---

## Where to look

| Thing                                    | File                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Types, the shareable list, redaction set | `lib/framework/resparkable/access/types.ts`                              |
| Every database read the layer makes      | `lib/framework/resparkable/access/store.ts`                              |
| The cascade, and the board-filter match  | `lib/framework/resparkable/access/cascade.ts`                            |
| The resolver and the public-link path    | `lib/framework/resparkable/access/resolve.ts`                            |
| "Is this share still live?"              | `lib/utils/share-window.ts` (shared with admin conversation shares)      |
| Behaviour tests                          | `tests/unit/lib/framework/resparkable/access/resolve.test.ts`            |
| Query-shape tests                        | `tests/unit/lib/framework/resparkable/access/store-isolation.test.ts`    |
| The D5 boundary, run as ESLint           | `tests/unit/lib/framework/resparkable/access/eslint-d5-boundary.test.ts` |
| The specification                        | [`plan.md`](./plan.md) §13, §16                                          |
