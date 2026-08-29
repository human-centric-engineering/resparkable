# Sharing — the access layer

How Resparkable answers **"may this viewer see this row?"**, and why the answer lives where it does.

This is the Release 2 companion to [`plan.md`](./plan.md) §13, which is the specification. This document is what a person reading the code needs: the boundary, the entry points, what each basis permits, and the four places the implementation deviates from the plan on purpose.

Status: **Release 2 is complete** — access resolution, the three tables, the ESLint boundary, public share links, named grants with `/shared-with-me`, invites, comments, and erasure.

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
| `framework_resparkable_comment`    | What a `commenter` grant is for               | `userId` is the **owner** again. The author is `authorUserId`, a second hand-written FK      |

### Two things about these tables that are easy to get wrong

**`userId` is the owner, not the grantee.** That is what preserves D1: the row cascades from `ResparkableSpace` like every other table in the tier, and `WHERE userId = $1` means the same thing here as everywhere else. Reading this table _by grantee_ is the one thing `repo/**` must never do.

**The grantee needs its own foreign key, and it is hand-written.** Nothing cascades to a grant row when the **grantee** is erased, because `userId` is the owner. `ON DELETE SET NULL` would be worse than no constraint at all: it leaves a live grant addressed by `granteeEmail` — retained personal data belonging to an erased person, on a row they cannot reach. So `framework_resparkable_grant_granteeUserId_fkey` is `ON DELETE CASCADE`, written by hand in the migration because `User` lives in a Sunrise-owned file, and guarded by **drift probe B8** (the sibling of B1, which guards the owner cascade).

That FK covers accepted grants. **Unaccepted invites have no `granteeUserId` to hang off**, and are covered by an erasure `scrubInTransaction` hook matching `granteeEmail`. Both halves are needed; neither covers the other. See "Erasure" below for how much rides on each.

### Why the token is hashed

`AiAgentEmbedToken` and `AiAgentInviteToken` store plaintext cuids. That is fine for admin-issued, deployment-scoped tokens. A brain share link is a bearer credential to a private person's life: a database dump or a log leak must not hand over every user's notes.

Mint with `randomBytes(24).toString('base64url')` — 192 bits, and deliberately **not** a cuid. Cuids are timestamp-prefixed and monotonic, precisely the wrong shape for "unguessable".

### The comment table repeats the grant's shape, including its trap

`userId` on a comment is the **owner of the item it sits on**, not the person who wrote it — so the row cascades from `ResparkableSpace` and `WHERE userId = $1` keeps meaning what it means everywhere else. The author is `authorUserId`, and like `granteeUserId` it needs a hand-written `ON DELETE CASCADE` into `"user"` because nothing else reaches it. **Probe B9** guards that FK, the way B8 guards the grant's.

`SET NULL` would be worse here than on a grant. There it leaves a live grant addressed by an erased person's email; here it leaves **free text an erased person wrote** — often about themselves — standing on somebody else's row under an author nobody can name.

**Comments are excluded from `ResparkableEmbedding`, from the context builder and from every background workflow**, and that is structural rather than a flag: nothing in `embedding/**` or `context/**` reads the table. A grantee's comment is third-party text arriving inside the owner's data, which makes it a prompt-injection vector aimed at the owner's own agent (§13). A future "summarise the discussion" feature has to make that exposure an explicit decision rather than inherit it.

---

## Entry points

```ts
resolveResparkableAccess({ viewer, entityType, entityId, need }); // one item
resolveResparkableAccessMany({ viewer, refs, need }); // a list
resparkableVisibilityScope(viewer); // "what is shared with me"
grantOwnerScope(grant); // a scope from a grant the viewer holds

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

### A cascaded item is a leaf of the share

`/shared/[type]/[id]` expands children **only when `basis === 'grant'`** — when the reader is looking at the item its owner actually handed over. A `grant-cascade` item returns `children: []`.

That is not tidiness, it is the "one level, never transitive" rule holding at the read surface as well as at the resolver. `goal → goal` is self-referential, so expanding a cascaded goal's children reaches a **grandchild** of the granted one — an item `resolveResparkableAccess` denies outright. Without the check, a reader was handed inside one payload the very row their next request would 404 on.

Every other type happens to be safe by accident (`project`/`board` cascade to tasks, which are leaves; `area`, `review` and `task` cascade to nothing), which is exactly why the rule is stated on the basis rather than on the type. Found by the phase 12–14 gate run's security pass.

**Sharing a project DOES include its tasks.** A project without its tasks is a title and a paragraph, and people work around that by pasting task lists into descriptions — strictly worse, because a paste goes stale, carries no redaction, and is invisible to revocation.

### The dynamic-filter trap

A board with `membership: 'filter'` is a live query. Sharing it does not share a fixed set of cards — it shares **every task matching the filter, including ones created later**. That is what people expect from "share my board", and it is also a standing leak: a task created next Tuesday that happens to match becomes visible to that grantee with no further action from the owner.

The code implements this faithfully rather than quietly narrowing it, and `resolve.test.ts` asserts it directly so it can never become an accident. Three mitigations belong in the share dialog, all required:

- **State the filter in plain English** — "Anyone with this link sees tasks matching: project = Acme Redesign, status is not done. This includes tasks you add later."
- **Show a live count** of currently-matching tasks before confirming.
- **Offer "share a snapshot instead"**, which flips the board to `membership: 'explicit'` and materialises today's matches. For anything leaving your organisation this is the safer choice, and the UI should say so.

An explicit-membership board has no such problem: its contents are exactly the rows you put in it.

---

## The dialog, and the three things a filter board must say

§13 requires all three mitigations, and `components/resparkable/share/share-dialog.tsx` is where they live:

1. **The rule, in plain English.** `describeBoardFilter` builds the sentence and `buildBoardView` returns it as `filterSummary` — on the server, because the honest version needs the project's _name_ and the filter holds only an id. It always ends by naming the consequence ("anyone you share it with also sees tasks you add later that match") rather than stopping at the criteria, which would be accurate and useless. It describes the board **the render path actually produces**: an unparseable filter falls back to showing everything, so the sentence says so rather than describing criteria nobody could read.
2. **The live count**, from `totalCards`.
3. **"Share a snapshot instead"** — `POST /api/v1/resparkable/boards/[id]/snapshot`, the only one of the three that is a mechanism rather than a warning. It flips the board to `membership: 'explicit'` and pins exactly the cards it shows now, in the order it shows them, inside one transaction. Already-explicit boards 404: re-pinning a board somebody curated by hand, from a filter that no longer describes it, would throw their arrangement away.

The membership comes from `buildBoardView`, never from a second query — the snapshot has to be what the owner was looking at when they pressed the button, cap and column order included, and a second implementation of "which cards are on this board" would eventually disagree with the first.

---

## Invites: the token that grants nothing

The distinction that makes this flow safe, and the one most easily lost:

|                             | Share link           | Invite token                                                         |
| --------------------------- | -------------------- | -------------------------------------------------------------------- |
| Holding it is               | **access**           | nothing                                                              |
| What it does                | resolves to the item | binds an **account** to a grant that already exists                  |
| Why the grant already works | —                    | `granteeClauses` matches on `granteeEmail`, so the address is enough |
| A forwarded email gets you  | the content          | a masked address and a refusal                                       |

The grant is live for its address from the moment it is issued. Accepting connects an account to it, so the relationship survives that person changing their address, and so the owner can tell an opened share from one still sitting in a mailbox. The token is hashed anyway — not because holding one is access, but because a dump full of live ones would let an attacker who _does_ control some of those mailboxes bind accounts silently, and there is no reason to make that cheaper.

**Sending is a separate call from creating the grant** (`POST /grants/[id]/invite`, not a flag on `POST /grants`). A mail-provider outage then leaves working access rather than a person told they have access and does not, and "send it again" is a button rather than a second grant. A send failure is reported, never thrown.

**The email names the kind of thing and never the thing.** A subject line lands in a preview pane, a lock screen, a shared screen and a mail provider's index; the whole point of the access layer is that content sits behind a resolution, and a title in a subject line is the one copy that never was.

**The wrong-account path shows a masked address.** §13 asks for two things that pull against each other — a different signed-in user cannot accept, and the wrong-user path must not leak the target address unmasked. `maskEmail` resolves it: `b***@e***.com` is enough to recognise your own mailbox and not enough to write to somebody else's.

Everything else is one answer. Unknown, malformed, revoked, expired and already-spent tokens all give the same 404, because anything distinguishable is an oracle about which invitations once existed.

**20/day per user**, the `resparkable-invite` tier — the only daily cap in the tier and the only one that is about somebody else's inbox rather than this deployment's bill. A share invite costs nothing to send and looks exactly like a real product notification, because it is one; the abuse shape is volume over time, not burst.

**Two deviations from §13 on the email itself.** It lives at `components/resparkable/emails/share-invite.tsx`, not `emails/resparkable-share-invite.tsx`: `emails/` is Sunrise-owned and holds platform defaults a fork may override, and the tier's own precedent (`capabilities/notify.ts`) is to import a component directly and hand it to `sendEmail({ react })`. And it is **not** registered as an `EmailKind`, because the registry exists so a fork can override an email the _platform_ sends, and nothing outside this tier sends this one.

---

## Comments: the one thing a grantee writes

`POST /resparkable/comments` asks the resolver for `need: 'comment'` rather than asking for `read` and checking a role. That is what refuses all three of the cases that must not write with one answer: a `viewer` grant, a **cascaded** grant of any role, and a public link.

**A cascaded item cannot be commented on, even under a commenter grant on its parent.** It was never chosen for sharing by its owner; commenting is something you do to the thing that was actually handed over.

**Editing is the author's alone; deleting is the author's or the owner's.** Rewriting somebody's sentence while leaving their name on it is worse than removing it — so the owner gets a delete and no edit. Somebody else's words standing in your own notes with no way to remove them is what makes people stop sharing, and the owner already decides whether the grant exists at all. Both rules live in `where` clauses rather than in prior checks, so they travel with the statement.

**The body is plain text, stored and rendered.** A comment is a sentence, not a document; giving third-party content a rendering pipeline on the owner's screen widens the surface for nothing the feature needs.

**Every write returns the whole thread.** A conversation changes between reads, and appending the one row a POST returned leaves the reader confidently looking at a thread missing what was said in between.

---

## Erasure

Almost all of it is Postgres, and that is the first thing to know about it. `ResparkableSpace` holds one hand-written `ON DELETE CASCADE` into `"user"` (**B1**) and every satellite table hangs off it. The two _cross-person_ cases have their own: `granteeUserId` (**B8**) and `authorUserId` (**B9**). Those are database constraints — they cannot fail to run, and `db:drift-check` fails if a migration ever recreates one with the wrong action.

`lib/framework/resparkable/privacy/erasure.ts` covers the residue, which is exactly two things:

| Residue                       | Why no cascade reaches it                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| An **unaccepted invite**      | `granteeUserId` is null, so the grant is addressed by email alone and there is no key to hang off |
| **Stored document originals** | Object storage cannot enlist in a database transaction                                            |

The scrub reads the address from the transaction (`ErasureTxContext` carries only `userId`, and hooks run **before** `user.delete()`) and lower-cases it — `granteeEmail` is stored lower-cased, and matching a `User.email` raw would leave the row of anybody who signed up with a capital letter. It **deletes** rather than nulls, for the reason `granteeUserId` is CASCADE rather than SET NULL: the owner's audit answer to "who did I share with" cannot be legitimate at the cost of holding an erased person's address on a row they can no longer see or revoke.

It deliberately does **not** delete comments. `authorUserId` is CASCADE, so `user.delete()` takes them a moment later; deleting them here as well would be a second definition of what erasure means, and two definitions drift.

### The registration hazard, said plainly

`lib/privacy/erasure-hooks.ts` is a plain module-scoped `Map`, and `eraseUser()` runs in the route realm while `initResparkable()` runs at boot. Under Next 16 + Turbopack those are different module graphs — the split sunrise#462 fixed for the contributor and capability registries and did not reach here. **A boot-registered erasure hook may not be present when erasure actually runs.** There is no point in the erasure route's import graph a fork can reach, so this is filed as ask #44 and carried.

It is tolerable only because of the table above: what rides on the hook is an unaccepted invite and some blobs, not the brain.

### Art. 15's other direction

`repo/subject-export.ts` is owner-scoped, so it cannot answer two questions that are about a subject but live on **somebody else's rows**: what has been shared _with_ them, and comments _they_ wrote elsewhere. `access/subject-export.ts` answers both — reading across a person is what that layer is named for — and `lib/app/data-export.ts` merges the two into one `resparkable` section.

It matches on **both** the account id and the address (an unaccepted invite has only the latter), **includes revoked and expired grants** (this is a record of what was done with the subject's data, and a withdrawn share is part of it), and carries **no content of what was shared** — a grant says _that_ somebody shared a project, and the project is theirs.

---

## Five deliberate deviations from the plan

Recorded here rather than quietly diverging.

**1. There is no `goal → project` cascade.** §13 describes the goal cascade as reaching "child goals and projects (and their tasks)". The schema has no such edge: a `ResparkableProject` hangs off an `areaId`, and its relationship to a goal is a user-authored `ResparkableLink` row. Following links would make the cascade transitive _and_ user-editable, which is exactly what "one level and typed" forbids; inventing an FK would change the data model to fit a cascade rule. So the goal cascade reaches child goals, and a project is shared by sharing the project.

**2. The ESLint boundary lives in `lib/framework/eslint.config.mjs`, not `lib/app/`.** The plan named the leaf-tier config. The framework tier is the right home: the rule is about framework-tier paths, and putting it in the leaf tier would mean every fork inherited a rule about a directory it does not own.

**3. `access/**` may import Prisma.** The plan's phrasing ("the repo layer is the only place that talks to the database") predates the shared-query layer existing. Routing shared queries through `repo/**` would mean giving that layer a way to say "not my rows" — precisely the capability it exists not to have. The boundary is not "one layer touches the database"; it is "each layer is named for the kind of query it may write".

**4. `boardFilterMatches` fails closed where `loadFilteredCards` fails open.** When a board's stored `filter` JSON does not parse, the render path (`services/board-view.ts`) falls back to an empty filter and shows everything live. Doing the same in the access layer would be fail-open in an authorisation path: a corrupt column would widen a shared board to the owner's entire task list. So it denies, and the resulting mismatch runs in the safe direction: the grantee sees fewer cards than the owner, never more.

**5. The cascade does not mirror a filter board's 300-card cap.** `loadFilteredCards` asks for `take: CARD_LIMIT` (300) ordered by `priorityScore desc`, so a filter board with more matches than that renders the top 300. The cascade applies no such cap, which means a task ranked 301st is granted by `resolveResparkableAccess` while the shared board never displays it.

This one is left standing rather than fixed, and the reason is that the fix is worse than the gap. Mirroring the cap means running a scored ranking query on the authorisation path, and it means access to a row depending on `priorityScore`, a number that moves on its own: a task could become readable or stop being readable overnight because something else was re-prioritised, with no gesture from the owner and nothing to point at in an audit. A ceiling on how many rows a board can display is a rendering decision; letting it silently become an access-control decision is the larger mistake.

Two related over-grants in the same family were **not** left standing, because neither had that objection. Archived rows are now excluded from the cascade (`findTaskFacts`, `findGoalParents`), since every render path already excludes them. And `findBoardsPinningTasks` now matches only boards still on `membership: 'explicit'`, so a board curated, shared and later flipped to a filter stops granting the tasks it was once pinned with. That second one is the one worth remembering: unlike an archived row, it never healed on its own.

---

## Public links, end to end

### Minting

`POST /api/v1/resparkable/share-links` → `services/sharing.ts` → `repo/share-links.ts`.

The token exists in memory for one function call. `mintShareLink` generates it, hashes it, stores the digest, and returns the plaintext to the route, which puts it in the 201 body. **Nothing in the system can produce it again** — not the owner's own link list, not the Art. 15 export, not a database dump. A lost link is re-minted, not recovered, and the UI has to say so.

Expiry is a tagged union rather than a nullable number:

```ts
expiry: { kind: 'days', days: 30 }   // the default
expiry: { kind: 'never' }            // has to be typed out
```

An `expiresInDays: number | null` field would satisfy §13's "null requires an explicit never-expires choice" on paper and miss the point: `null` is what an empty form field serialises to, so the strictest setting would be the one a client reaches by omission.

### `visibility` is a cache, maintained transactionally

Minting flips the item to `visibility: 'link'`; revoking the last live link flips it back to `'private'`. Both happen in the same transaction as the link write, because `visibility` exists so a list can render a "shared" badge **without joining to the link table** — which makes it a cache, and a cache updated in a second statement goes wrong the first time a request dies between the two.

The sibling count in `revokeShareLink` is taken **inside** the transaction. Two people revoking the last two links at once would otherwise each see the other's link as still live, and neither would flip the badge.

### The reader

| Surface                                 | What it is                                                                |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `app/(public)/s/[token]/page.tsx`       | The page. Server component; calls the service directly, no HTTP hop       |
| `app/api/v1/resparkable/public/[token]` | The JSON, for anything that wants it without the page                     |
| `repo/shared-view.ts`                   | The projection — an **allowlist**, and the only place in the tier that is |

**Every failure is the same failure.** Unknown token, malformed token, revoked link, expired link, and a link whose item has since been deleted all return the same 404 with the same body and the same headers. Anything distinguishable turns the response into an oracle telling a stranger which tokens once existed, and roughly when.

**Three headers, on the miss as well as the hit:**

- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` — `robots.txt` is advisory and does not remove an already-indexed URL. Crawlers fetch APIs directly, so the header is set here as well as in the page's metadata.
- `Referrer-Policy: no-referrer` — the token is in the _path_. The deployment-wide `strict-origin-when-cross-origin` already strips the path from cross-origin requests, so the token does not leak by default; this sends nothing at all, including the origin. On the page the same thing is done with `metadata.referrer`, because a page cannot set response headers in the App Router — and that needs no core edit.
- `Cache-Control: private, no-store` — a revoked link must stop working immediately, and it cannot if a proxy is still serving the last 200.

**Remote images are click-to-load.** The CSP allows `img-src https:`, so a tracking pixel in a note would fire for every reader the moment the page rendered. On the owner's own surfaces that is self-inflicted; here it is not — the reader never agreed to it and cannot see it happening. Same-origin and `data:` images render normally. Tightening `img-src` globally would break every legitimate image on the owner's surfaces to close a hole that exists only here.

**Archived items still resolve.** The owner retired the thinking; they did not revoke the link. A reader following a URL they were given should see what it points at rather than a 404 they cannot explain — and the page marks it as archived so they know they are looking at something set aside. Revocation is the gesture that closes a link.

### The projection is an allowlist, and that inversion is deliberate

Everywhere else in this tier the rule is `omit`, not `select`: a column added tomorrow should be _exported_ by default rather than silently dropped from a subject-access bundle. `repo/shared-view.ts` inverts it. A column added to `ResparkableTask` next month must not appear on a public page because nobody remembered to exclude it.

`tests/unit/lib/framework/resparkable/repo/shared-view.test.ts` asserts the `select` objects handed to Prisma against a forbidden-column list, rather than the returned shape — a value that is never fetched cannot be leaked by a serialiser downstream, and one that _is_ fetched can be, by any of them.

Never fetched: `priorityScore`, `priorityFactors`, `manualBoost*`, `snoozeCount`, `deferUntil`, `energy`, `estimateMinutes`, `contextTag`, `lastActivityAt`, `slug`, `rev`, `indexedHash`, `visibility`, every foreign key, a board's `filter`, a review's `payload`, and the whole of `ResparkableEvent`.

**A board's children come from `services/board-view.ts`**, not from the repo. A filter-backed board is a live query, and resolving its membership anywhere but the module that renders it would be a second copy of the filter predicate — where the disagreement shows up as a shared board displaying different cards from the owner's.

### Rate limiting

A new `resparkable-public` tier: **60/hour per IP**, registered for both `/api/v1/resparkable/public/**` and `/s/**`. Two rules because the page calls the service directly rather than fetching its own API, so the API rule never fires for a browser.

Keyed on IP because there is nothing else to key on — which means a shared office NAT shares a budget, which is why the cap is sixty rather than ten. The token is 192 bits, so this is not what stops an attacker guessing; what it stops is a script burning database lookups for free.

---

## Shared-in items get their own surface

They do **not** appear in the viewer's own lists or search. Three reasons, in weight order:

1. It preserves `WHERE userId = $1` as an unconditional invariant on every list, search and embedding query in the tier.
2. A second brain's lists are a **planning** surface. Someone else's project sitting in "my projects" corrupts prioritisation and your own sense of what you have committed to.
3. Mixing them in would make ~40 list endpoints potential leaks, rather than the ~6 that have to be got right.

`/shared-with-me` has its own routes under `/api/v1/resparkable/shared/*`, its own search that explicitly does **not** touch `ResparkableEmbedding`, and no write paths.

**The list shows direct grants only.** A shared project's tasks are reached by opening the project. Flattening the cascade into the list would answer "what has Priya given me?" with two hundred rows when the honest answer is one project — the cascade is a property of the thing that was handed over, not a second set of things that were.

**The search is a substring match and says so.** The owner's search is hybrid: a vector query against `ResparkableEmbedding` blended with BM25. This one enumerates the granted refs and their one-level cascade, projects them through `repo/shared-view.ts`'s allowlist, and filters the normalised `title` and `body` in memory. Three things follow, and the first is why it is built this way:

1. **It cannot touch the owner's embeddings, because it never issues a query that could.** Structural rather than a filter somebody has to keep correct. `shared-with-me.test.ts` mocks the embedding repo to _throw_, so a future call that reached it fails the run rather than passing on a stubbed empty array.
2. **It cannot find a rewording.** "deadline" will not find "due Friday", and the UI's placeholder says "match words" rather than "search" for that reason.
3. **It filters the projection, not the table**, so a query cannot be used to probe for words in text the viewer is not allowed to read — `notes` under a grant that did not open them is not searched because it was never fetched.

It stops at `SHARED_SEARCH_SCAN_LIMIT` (1000 refs) and reports that it did. A cap that truncates silently reads as "this is everything".

### Getting an `OwnerScope` from a grant you hold

`/shared-with-me` resolves a viewer's whole grant set in one query and then has to read the granted items — which means a scope per owner, without re-resolving each item and throwing the answer away. `grantOwnerScope(grant)` is that, and it is the fifth legitimate source of a scope alongside `sharedOwnerScope`. It is safe for the same reasons: **the id comes off a database row, never off the request**, and a `LiveGrant` is only ever produced by `access/store.ts` from a row that survived `isShareActive` and a grantee match on the viewer's own session id or address. Holding the grant _is_ the resolution.

Keep `rg 'grantOwnerScope\('` as short as `rg 'sharedOwnerScope\('`.

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
| Minting, revoking, the public payload    | `lib/framework/resparkable/services/sharing.ts`                          |
| Issuing, amending and revoking a grant   | `lib/framework/resparkable/services/grants.ts`                           |
| The owner's side of a grant, in SQL      | `lib/framework/resparkable/repo/grants.ts`                               |
| `/shared-with-me`, and its search        | `lib/framework/resparkable/services/shared-with-me.ts`                   |
| Building a viewer from a session         | `lib/framework/resparkable/api/viewer.ts`                                |
| The owner's share dialog                 | `components/resparkable/share/share-dialog.tsx`                          |
| The filter-board sentence and snapshot   | `lib/framework/resparkable/services/board-view.ts`                       |
| Minting, sending and accepting an invite | `lib/framework/resparkable/services/invites.ts`                          |
| The invite email                         | `components/resparkable/emails/share-invite.tsx`                         |
| Comments, and who may write which verb   | `lib/framework/resparkable/services/comments.ts`                         |
| The comment thread's queries             | `lib/framework/resparkable/repo/comments.ts`                             |
| The erasure hook, and what rides on it   | `lib/framework/resparkable/privacy/erasure.ts`                           |
| Art. 15's cross-person half              | `lib/framework/resparkable/access/subject-export.ts`                     |
| The owner's side of a link               | `lib/framework/resparkable/repo/share-links.ts`                          |
| The reader's projection (allowlist)      | `lib/framework/resparkable/repo/shared-view.ts`                          |
| The reader page                          | `app/(public)/s/[token]/page.tsx`                                        |
| The reader's JSON, and its headers       | `app/api/v1/resparkable/public/[token]/route.ts`                         |
| Crawler exclusion (fork seam)            | `lib/app/robots.ts`, spread by `app/robots.ts`                           |
| The specification                        | [`plan.md`](./plan.md) §13, §16                                          |
