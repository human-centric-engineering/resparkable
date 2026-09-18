# Phase 46 to 48: the group, and the space it owns

**Scoped 2026-09-01.** The specification is [`plan.md`](./plan.md) §23.3 to
§23.6, and it stays the specification. The route through it is
[`release-9-plan.md`](./release-9-plan.md)'s Branch 2. This document is the
design: what the branch decides, where it departs from either of those and why,
and what it deliberately does not do. Where this document and §23 disagree, §23
wins and this document is wrong.

Same relationship and same shape as [`phase-45-plan.md`](./phase-45-plan.md),
one branch on. That one had to justify a migration over every table in the tier;
this one has to justify three new tables that are not in the tier's cascade at
all, which is a smaller job with a sharper edge: phase 45 could not leak,
because it changed no behaviour. This one is the phase where a second person
first reads somebody else's rows.

## Where phase 45 left it

Landed on `main` 2026-08-29 (PR #70). What this branch inherits, and what it
therefore does **not** have to build:

- `ResparkableSpace.spaceId` is the key on the parent and on all 23 satellites.
  A space's key is no longer its owner's identity.
- `ResparkableSpace.kind` is `personal | group`, and `ownerUserId` is nullable
  and deliberately not unique.
- **Probe B12 already asserts the ownership invariant as a database CHECK**: a
  `personal` space has an owner, a `group` space has none. §23.6 and the release
  plan both assign that to phase 48 as "extend probe B1". It is done, it is a
  `CHECK` rather than a test fixture, and phase 48's job there shrinks to the
  half B12 cannot express: that nothing in the group service ever writes an
  `ownerUserId` in the first place, which fails as a constraint violation rather
  than as a silent leak. That is the good direction for it to fail in.
- `createdByUserId` is on every satellite already (probe B11), with the
  `SetNull` action §23.5 asks for. Nothing in phase 48 needs to add it.
- `SpaceScope` carries `actorUserId` and `role`, both inert. `spaceScopeFor()`
  exists and refuses `owner` without an actor.

So Branch 2 adds membership, and wires the existing seams to it. The columns it
would otherwise have had to migrate are already there, which was the point of
carrying them in phase 45.

---

## Phase 46: the group and its members

### Decision 1: three tables, not two

§23.3 specifies two, `ResparkableGroup` and `ResparkableGroupMember`. This
branch ships a third, `ResparkableGroupInvite`, and the reason is a semantic
difference from §13 that only shows up when you try to fold the invite into the
membership row.

A **grant** is live from the moment it is written. `granteeClauses` in
`access/store.ts` matches on the lower-cased address, so the person can read the
item before they ever open the email, and the token binds an account to a
relationship that already works (`services/invites.ts` opens by saying so). One
row can therefore carry `granteeEmail`, `granteeUserId` and `inviteTokenHash`
together, because all three describe one live thing.

A **group invite must grant nothing until accepted**. That is phase 46's own
acceptance criterion in §15, and it is not a preference: membership is write
access to an entire brain, not read access to one project. So the invite and the
membership are two different objects with two different lifetimes, and the row
shapes follow:

- Folding them into one table needs `ResparkableGroupMember.userId` to be
  nullable, which silently destroys `@@unique([groupId, userId])`, because NULLs
  do not collide in a Postgres unique index. One address could then be invited
  five times and the database would not object. That is the same class of
  failure `@@unique([entityType, entityId, granteeEmail])` exists to prevent on
  the grant side.
- It also puts an `email` column on a membership table where it would mean
  something different from membership, and every reader of
  `resolveSpaceScope()` would have to remember that some member rows are not
  members.

So: `ResparkableGroupInvite` is addressed by email and holds the token digest,
and accepting it **creates** the membership row inside one transaction and marks
the invite accepted. A revoked or expired invite creates nothing. The token
shape is §13's exactly, and deliberately so: `randomBytes(24).toString('base64url')`,
sha256 at rest through the existing `hashShareToken`, `grantExpirySchema`'s
30-day default and 365-day maximum, `isShareActive` for the window, an identical
response whether or not the address has an account, and never `Verification`.
`services/invites.ts` is the file to copy, not to generalise: the two flows share
a shape and not a code path, and merging them would put "grants nothing until
accepted" and "already live for that address" behind one function whose comment
has to explain both.

**Departure recorded**: §23.3 says two tables. This is three. The two it names
keep the columns it gives them.

### Decision 2: what hangs off what, and which cascade reaches it

§23.3 says both tables are "outside the D1 cascade, because they describe the
relationship rather than the brain". That is right about D1 and needs stating
precisely, because the group row does have a foreign key to a space.

| Edge                                              | Action    | What it means                                           |
| ------------------------------------------------- | --------- | ------------------------------------------------------- |
| `ResparkableGroup.spaceId` → space                | `Cascade` | Deleting the space removes the group row                |
| `ResparkableGroupMember.groupId` → group          | `Cascade` | Deleting the group removes its memberships              |
| `ResparkableGroupMember.userId` → `User`          | `Cascade` | Hand-written, probe B13. Erasure removes memberships    |
| `ResparkableGroupMember.invitedByUserId` → `User` | `SetNull` | Hand-written, B13. The inviter leaving keeps the member |
| `ResparkableGroupInvite.groupId` → group          | `Cascade` | Deleting the group removes its outstanding invites      |
| `ResparkableGroupInvite.invitedByUserId` → `User` | `SetNull` | Hand-written, folded into B13's parameterised sweep     |

"Outside D1" means the three tables are **not scoped satellites**: they carry no
partition key, `spaceWhere()` never touches them, they have no
`createdByUserId`, and no function in `repo/**` reads them with a `SpaceScope`.
It does not mean the group row floats free of its space. A group whose space had
been deleted would be a group nobody can open and nothing can clean up, so the
FK is real and it cascades.

The direction matters and is worth reading twice: **deleting a space deletes the
group, not the other way round.** That is what makes phase 48's group deletion a
single `DELETE` of the space row, which the existing D1 cascade then follows
through all 23 satellites, with the group and its memberships going with it. No
new deletion machinery, and no ordering to get wrong.

Erasure reaches none of it, because a group space has `ownerUserId IS NULL` and
B12 makes that a database rule. That is §23.6 working, and it now works by
construction rather than by anybody remembering.

### Decision 3: `maxMembers` lands now and is enforced in phase 57

The column is in the release plan's phase-46 schema and not in §23.3's. It is
one `Int @default(50)` on a table with no rows yet, and the alternative is a
second migration on the same table in phase 57 for one column. Landing it now
costs nothing. **Nothing enforces it in this branch**, and that has to be said
in the schema comment or the next reader assumes a cap that is not applied yet.

### Decision 4: membership resolves once, in one file

`lib/framework/resparkable/services/membership.ts` is the only place membership
is read on a request path, and `resolveSpaceScope(actorUserId, spaceId)` is the
only function that turns a membership row into a `SpaceScope`. One indexed read
on `@@unique([groupId, userId])`, one `spaceScopeFor()` mint, no join anywhere
near a list query.

This is D5's whole load-bearing claim and it survives only if nothing else ever
does it. Two things keep it honest:

- `rg 'spaceScope\(|spaceScopeFor\('` stays the complete list of trust
  boundaries in the brain. This branch adds two call sites to it, both in this
  one file.
- `repo/isolation.test.ts`'s second sweep already asserts that no repo query's
  `where` mentions `actorUserId` at any depth. It was written in phase 45 when
  `actorUserId` was inert. From this branch on it is not inert, and that sweep
  becomes the thing standing between a group space and a per-row ACL.

**A pending invite resolves to no scope at all.** Not a `viewer` scope, not a
scope with an empty space: `null`, and the route 404s. §23.11's pending-approval
membership (phase 57, a row with `joinedAt: null`) resolves the same way, and
this branch writes the resolver so that phase 57 adds a predicate rather than a
branch.

### Decision 5: `repo/groups.ts` is the second exception to the D5 signature rule

Every function in `repo/**` takes a `SpaceScope` first, and `repo/space.ts` is
documented as the one exception because it is where a scope comes from. This
file is the second, for exactly the same reason and no other: membership is what
a group scope is minted **from**, so it cannot take one.

The exception is narrow and stays narrow. Reads here take a verified
`actorUserId` from the session and a `groupId` or `spaceId` from a validated
route param, and the file is short enough to audit at a glance, which is the
property `repo/space.ts`'s header claims for itself and the reason to keep both
small. Everything that reads brain content still goes through a scope.

`repo/isolation.test.ts`'s `SCOPED_CALLS` table is hand-maintained rather than
derived, so nothing fails when this file is left out of it. It gets a comment in
that table naming the file and the reason, beside the one `repo/space.ts` has,
because "absent from the sweep" and "forgotten" are indistinguishable otherwise.

### Decision 6: the last-admin rules are service rules, and so is one group one space

In `services/membership.ts`, never in a route, and asserted in unit tests
against the service:

- The last admin cannot leave, be demoted, or be removed. The 400 names the
  reason and says to promote somebody first.
- When the last admin is **erased**, the role transfers to the longest-standing
  remaining member (§23.3, and §18's circle rule before it). This is phase 48's
  hook; the rule and its test live here from the start so the hook has something
  to call.
- A group whose last member leaves is deleted rather than left as an unreachable
  space holding rows.
- **One group, one space.** §24.1 removed `@unique` from the group's space
  column in phase 45 so that Release 10 can give one owner several workspaces;
  the group side of that stays a service rule until §23.14 q6 is answered. The
  create path mints the space and the group in one transaction and there is no
  route by which a group acquires a second space, which is what §23.3 asks for.

### Decision 7: the group space is created by the group, and is never `ensureResparkableSpace`'s job

`ensureResparkableSpace(userId)` mints a personal space keyed on a user id, sets
`ownerUserId` to the same value, and seeds jobs and a credit account. A group
space is created once, by `createGroup`, with `kind: 'group'`,
`ownerUserId: null`, `isDefault: false`, its own cuid key, and a name and slug
that come from the group. It is not reachable through the personal path and the
personal path is not parameterised to reach it: two callers of one function with
opposite invariants is how a group space ends up with an `ownerUserId`, which
B12 would then reject at 500 on somebody's first group.

Jobs and billing for a group space are phase 50's (§23.12: the budget is a cap
somebody sets, and a group space with no top-up spends nothing). This branch
creates the space row and its inbox token and stops there, and the group create
path says so in a comment rather than leaving a reader to wonder why
`ensureResparkableJobs` is missing.

### Decision 8: privacy, and the departure from the release plan

The release plan says the two new tables "belong in `lib/privacy/export-sources.ts`
proper, reached through `lib/app/data-export.ts`". They do not, and the reason is
an arrangement that postdates that sentence.

`lib/privacy/export-sources.ts` is **core-owned**, and every Resparkable table is
listed in `tests/unit/lib/privacy/export-sources.test.ts`'s
`HANDLED_OUTSIDE_MANIFEST` under sunrise#533, precisely because the tier exports
through the `lib/app/data-export.ts` seam and carries its own completeness
guard. Putting two Resparkable tables into the core manifest would reverse that
for two rows and leave the other 24 where they are.

What this branch does instead, which is the same answer §23.6 wants by a route
that already exists:

1. **The collector goes in `access/subject-export.ts`, not `repo/subject-export.ts`.**
   That file is already the tier's answer to "what about this subject lives on
   rows that are not theirs", and it is keyed on `userId` and `email` rather than
   on a scope. A membership is exactly that shape. The space-scoped manifest
   cannot express it, for the same reason it could not express a grant addressed
   to the subject.
2. **The tier's guard gains a third category.**
   `tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts` today
   demands that any model carrying a `userId` is in
   `RESPARKABLE_SUBJECT_SOURCES` or `RESPARKABLE_EXCLUDED_MODELS`, and both
   describe space-scoped reads. `ResparkableGroupMember.userId` matches the scan
   and belongs in neither, so a `RESPARKABLE_CROSS_SUBJECT_MODELS` set is added
   beside them and the guard checks all three. Without it the guard is the one
   that goes red for the right reason and gets silenced the wrong way.
3. **The core test's fork block gains the three model names**, with the same
   sunrise#533 note the other 24 carry.

What the subject receives: the groups they belong to, their role, when they
joined and who invited them; invitations addressed to them, accepted or not; and
invitations they sent, by id and date. Not the group's content, for the reason
`access/subject-export.ts` already gives about a grant: that is other people's
data, it sits behind live membership, and an export bundle is a file that gets
emailed around.

**`transfer/policy.ts`**: all three tables are `excluded`, with written reasons,
in this phase rather than inheriting a default. A group space is not transferable
with an account (§23.6): taking your account elsewhere does not take a shared
workspace with you, and importing a membership row would be an assertion about
other people's group that the far side has no way to check.
`policy-coverage.test.ts` diffs the policy against the real model graph, so all
three fail the build until they are listed.

### Decision 9: one new drift probe, parameterised like B11

**B13** covers the three hand-written `User` foreign keys these tables need:
`ResparkableGroupMember.userId` (`Cascade`), and `invitedByUserId` on both the
member and the invite (`SetNull`). One probe over a table of
`(table, constraint, action)` rather than three registrations, following B11's
precedent and for its stated reason: the check output has to stay readable.

The two actions are the design rather than a detail. A member's row **is** their
membership, so erasure takes it. An inviter's name on somebody else's invitation
is attribution, so it nulls out and the invitation stands: an inviter closing
their account must not silently withdraw an invitation the invitee is about to
accept.

Both are hand-written for the reason B1, B8, B9 and B11 are: `User` lives in a
Sunrise-owned schema file and Resparkable must not add a relation field to it.
Both are the class of failure that surfaces as a regulatory problem rather than
a stack trace, which is why the probe asserts the `ON DELETE` action and not
mere existence.

The schema header and `lib/app/db-drift.ts` both name a count. Phase 45 found
both stale and left the inventory as the source of truth. This adds one and
updates neither number, because there is no number left to update.

### Decision 10: routes and rate limiting

Five files, hand-written and modelled on `app/api/v1/resparkable/grants/route.ts`
rather than generated by `createCollectionHandlers`, which hard-codes
`spaceScope` and cannot mint a group scope:

```
GET  POST         /api/v1/resparkable/groups
GET  PATCH DELETE /api/v1/resparkable/groups/[id]
GET  POST         /api/v1/resparkable/groups/[id]/members
PATCH DELETE      /api/v1/resparkable/groups/[id]/members/[userId]
POST              /api/v1/resparkable/groups/[id]/invites
```

Two conventions carried over from the sharing routes without restating the
reasoning: **404 rather than 403** for a group the caller is not in, because a
403 confirms the row exists to someone who guessed an id; and **no email address
in any log line**, because that is one person's contact details in another
person's infrastructure for the life of the log.

Rate limiting: the invite route joins the existing `resparkable-invite` tier
(20/day, session-user), matched on the `/invites` suffix exactly as the grant
invite rule is matched on `/invite`. Everything else inherits the section's
100/min from `proxy.ts` and no handler calls a limiter itself. §23.11's two new
tiers are phase 57's, when there is a join link to cap.

`DELETE /groups/[id]` is admin-only and lands in this phase as the route; its
typed confirmation and member notification are phase 48's (§23.6), and until
then it is behind the same admin check and does the same cascade.

---

## Phase 47: the switcher, and capture that names its target

Design detail is thinner here on purpose: it is UI over seams this branch has
already built, and the decisions that matter are about defaults rather than
structure.

### Decision 11: the space is one search param, and absence is personal

§24.2 says the active workspace is "held in the shell and in the URL, never in
a cookie alone" and does not say what that looks like. This branch spells it
`?space=<spaceId>`, on page URLs and API paths alike, with **absence meaning
the personal space**.

A path segment (`/resparkable/s/<slug>/today`) was the alternative and is
rejected on cost: it restructures 27 page files and every route in
`ui/routes.ts` to buy a prettier URL, and it makes every existing bookmark and
emailed link a redirect. A search param leaves all of them resolving exactly as
they do today, which is the same property phase 45 bought by keeping a personal
space's key equal to its owner's user id.

Absence has no second spelling. Not `?space=personal`, and not the owner's user
id: the first is a magic value every reader would have to know about, and the
second puts a user id in every URL, and therefore in every access log, referrer
header and pasted link. `resolveActiveSpaceScope` still accepts the user id,
because a switcher built the link and the personal space's key genuinely is
that value, but nothing generates it.

A repeated `?space=a&space=b` resolves to **nothing**, not to the first value.
Two answers to "which brain" is not a question with a sensible default, and
picking one is a coin toss whose losing side is a cross-space read attempt.
Resolving to personal makes it fail as a 404 on the caller's own space.

### Decision 12: ambient for reading, explicit for capture

The switcher makes the space ambient, and ambient state is what mis-targets a
capture. So the two directions get opposite defaults, and the rule is short
enough to hold in the head: **a surface that displays a workspace reads the URL;
a path that creates a row does not.**

- `requestSpaceScope(request, session.user.id)` in `api/space-request.ts` is the
  one line a read or an in-place mutation writes. It reads `?space=`, resolves
  membership and throws `NotFoundError` on refusal.
- Every capture path takes its target from an **explicit field** and defaults to
  personal, and none of them calls `requestSpaceScope`. Test 13e asserts it per
  path.

The side effect is that the greppable trust boundary §23.4 leans on gets
_shorter_. `rg 'spaceScope\(|spaceScopeFor\('` used to return fifty route
files, each an unaudited mint; it now returns `services/membership.ts` plus the
background and export paths that have no session to read. A list that fits on
one screen is a list somebody will actually read.

**The switcher is in the shell header** (§24.2), in
`components/resparkable/shell/app-header.tsx`'s right cluster, because that is
the one piece of chrome always on screen. The active space is **in the URL**, so
a space is a link and browser-back works. Personal and group spaces sit in one
list, grouped and labelled by kind.

**Tab state is per space and survives a switch.** `workspace-context.tsx`
persists per surface under `resparkable.workspace.v2`; the key gains a space
segment. A migration for existing keys is not needed: an unrecognised key reads
as no state, which is a fresh tab set, which is the correct answer for a space
you have not opened before.

**Capture always names its target, and the default is always personal.** Six
paths, six separate assertions (test 13e), because a thought landing in the
group brain because the last space was sticky is the mortifying failure this
feature has:

| Path              | Entry point                                 | Default           |
| ----------------- | ------------------------------------------- | ----------------- |
| Quick capture     | `POST /api/v1/resparkable/capture`          | personal          |
| PWA share target  | the same route, via `/resparkable/capture`  | personal          |
| Email inbox token | `capabilities/capture-for-token.ts`         | the token's space |
| Voice             | `POST /api/v1/resparkable/transcribe`       | personal          |
| Image             | `POST /api/v1/resparkable/transcribe/image` | personal          |
| Sparkey composer  | `resparkable_capture_thought`               | personal          |

The email path is the one that is already correct and must not be "fixed": the
token **is** the space, so there is no default to choose and no selector to add.

**A space id in a request body is a target, never an authority.** Every one of
these routes takes the space id through `resolveSpaceScope()`, which reads
membership, and a non-member gets a 404. **No capability accepts a space id as
an LLM-supplied argument**, for the reason none accepts a user id today: every
`agent*Schema` is `.strict()` and `capabilities/scope.test.ts` sweeps every
handler.

**Agents and context follow the space, not the actor** (§23.9).
`loadResparkableContext` reads the space id rather than `request.userId`, and
`buildContext`'s `type:id:userId` cache key carries the space. That key change is
safe **only because** the content is now space-derived, and the docblock has to
say so, or the next reader assumes the leak the old key was guarding against.
`chat/stream/route.ts` keeps pinning `contextId` server-side; it becomes the
resolved space id.

**Sensitivity is a warning, never a filter.** `ResparkableThought.sensitivity`
still classifies, and in a group space it prompts at the point of capture. Using
it to hide a row would build §23.4's forbidden per-row ACL through a side door,
so the warning is UI-only and no query reads it.

New section wiring follows `ui.md`'s checklist in full: `ui/routes.ts`,
`ui/nav-groups.ts`, `ui/section-help.ts` (its coverage test fails otherwise),
`ui/workspace/tab-registry.ts`, a `workspace/tabs/groups-tab.tsx` adapter,
`ui/payloads.ts`, `api/endpoints.ts`, and `ui/workspace/change-scope.ts`.

**Reuse rather than rebuild.** The grants half of `share-dialog.tsx` is already
an invite-a-person-with-a-role form; `my-shares-view.tsx` is the list-with-revoke
pattern with optimistic remove and rollback; `accept-invite.tsx` plus
`invite/[token]/page.tsx` is the whole token to session to bind to redirect flow.

### What phase 47 actually shipped, and where it departed

Landed on `main` 2026-09-03. Six departures from the text above, all found by
building it rather than by re-reading the plan.

**1. Two of the six capture paths cannot write a thought.** `/transcribe` and
`/transcribe/image` return text into the capture box; neither calls
`captureThought` or creates anything. That is what makes them safe, and it is a
better answer than a default would have been, so test 13e asserts the absence
rather than inventing a default for them to have. §24.2's table lists them as
entry points because they are entry points for a _person_; in this codebase they
are not entry points for a _row_.

**2. Quick capture and the Sparkey composer were posting to `/thoughts`.** The
plan's table says `/capture` and always did; the UI had drifted, and the drift
only became dangerous in this phase, because `/thoughts` is the ordinary CRUD
create and now follows the ambient workspace. Both moved.

**3. `resolveSpaceScope()` is three functions.** `resolveGroupSpaceScope` (phase
46, by space id), `resolveGroupMembership` (phase 46, by group id) and
`resolveActiveSpaceScope` (phase 47, the entry point that short-circuits the
personal case). The plan's single name would have hidden the short-circuit,
which is the thing that keeps a membership read off every request in the
product.

**4. The outbound-sharing routes follow the ambient workspace.** `grants`,
`shares` and `share-links` were not mentioned in either plan for this phase.
Leaving them personal would have made "share this project" 404 inside a group,
because the item is in the group's space and the scope would not be. What phase
49 still owns is unchanged: a grant whose _grantee_ is a group.

**5. `vault/export` and `vault/import` stay personal, deliberately.** §24.5 has
not settled what exporting a group workspace means, and both answers are
data-protection decisions rather than routing ones: an archive of a shared brain
is several people's content in one person's download, and an import into one
writes somebody else's rows under the importer's name. The question stays
visibly open in a comment rather than being answered by a one-line edit.

**6. `requireResparkableSpace`'s background route still trusts its carrier.**
The tightening it wants is a `context.scopeIsAuthoritative` check, which is the
field core provides to tell a platform-written carrier from a consumer-supplied
one. Adding it blind would silently stop every 04:30 run if the scheduler path
turns out not to set the flag, so it needs a test proving that first. Named in
the code rather than left as a gap to rediscover.

One boundary worth stating because it will come up again: **a capture is aimed;
everything else follows the room you are in.** A document upload from the
capture box lands in the workspace on screen, like every other CRUD create,
because a document is added _to_ a workspace. A thought is caught first and
targeted second, which is why it is the one write path that ignores `?space=`.

---

## Phase 48: erasure, isolation, and the honest export

Most of this phase was paid for in advance. What is left:

- **The member-erased hook.** `lib/framework/resparkable/privacy/erasure.ts`
  gains admin succession: when the erased member was a group's last admin, the
  role transfers to the longest-standing remaining member, and a group left with
  no members at all is deleted. Everything else is database constraints doing
  their job, and the hook must not duplicate them: memberships cascade,
  `createdByUserId` nulls out, and the group space is untouched.
- **Group deletion gets its explicitness.** A typed confirmation naming the
  group, and a notification to every member. Not a menu item beside "leave
  group", which is the same discipline §13 demands for a never-expiring link.
- **Art. 15 gains its first predicate source.** A subject's export contains
  their personal spaces in full, their memberships and invitations, and rows in
  group spaces where `createdByUserId` is them. `SubjectDataSource.scopeNote` is
  the field for saying what a source withholds and why, and it is surfaced in
  the export's own `meta`. A source that narrows without one is the silent
  omission the manifest exists to prevent.
- **B12's other half.** The CHECK stops a group space acquiring an owner. What
  it cannot see is a group service that tries: a test asserts `createGroup`
  writes `ownerUserId: null`, so the failure is a red test rather than a 500 on
  somebody's first group.

Tests 13b to 13e. **13b is the single most important assertion in the release**:
a non-member's request for a group space's content returns nothing, on every
list endpoint, by scope resolution and not by filtering.

---

## What this branch deliberately does not do

- **No join links, no approval queue, no member cap enforcement.** §23.11, phase 57. `maxMembers` is a column with nothing reading it.
- **No group-to-group grants.** §23.7, phase 49. `ResparkableGrant.granteeSpaceId`
  does not exist yet and the share dialog still names people.
- **No digest, no budget, no credit ledger for a group space.** §23.8 and
  §23.12, phase 50. A group space has no credit account and no jobs, which means
  no scheduled work bills anybody, which is the safe state to ship in.
- **No activity feed.** §23.10, phase 59.
- **No assignment, no comments on the space basis, no `rev` on the write path.**
  §23.13, phase 58. Two members editing one task in this branch is last-write-wins,
  which is the behaviour a single-owner brain has today and is not a regression;
  it is just not yet the feature.
- **No second personal workspace.** Release 10. The switcher lists what exists,
  and for a user in no groups that is one space and the switcher does not render.

---

## How this goes wrong, ranked

1. **A membership read reaches a list query.** The failure is not an error, it
   is forty endpoints acquiring a per-row ACL one convenience at a time, and the
   first one looks completely reasonable in review. _Mitigation:_ one resolver
   file, the `spaceScopeFor(` grep staying short, and `isolation.test.ts`'s
   `actorUserId` sweep, which stops being theoretical the moment this branch
   lands.
2. **An invite grants something before it is accepted.** §13's mechanism is
   copied by shape, and its semantics are the opposite of this one's. A copy
   that also carried `granteeClauses`-style email matching would make an
   uninvited mailbox a member of a group. _Mitigation:_ separate table, no email
   matching anywhere in the resolver, and a test that asserts a pending invite
   resolves to `null` rather than to a viewer.
3. **A group space gets an `ownerUserId`.** One person's account closure then
   takes a shared workspace with it. _Mitigation:_ B12 makes it a constraint
   violation rather than a silent write, plus the service-level test above.
4. **The privacy guards go green while guarding nothing.** Exactly what phase 45
   found in `export-sources.test.ts`, one release earlier, and the new tables are
   the same shape of blind spot: a model the scan sees and neither manifest
   claims. _Mitigation:_ the third category in the tier's guard, and a
   guard-on-the-guard count in the same test.
5. **Capture defaults to the last-used space.** The mortifying one, and it
   arrives as a convenience nobody argues with. _Mitigation:_ test 13e asserts
   the default per path, six times, rather than once over a shared helper.

---

## Commit order

Three guards go red the moment the schema lands and green only when the manifest,
the tier's own coverage test and `transfer/policy.ts` all name the new tables. So
they ship **in** the schema commit rather than three commits later: a commit that
leaves the suite red is a commit nobody can bisect through.

| #   | Commit                                                                                                                       | Why it is green                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | This design doc                                                                                                              | text only                                                                          |
| 2   | Schema: three models, the migration, B13, the model graph, and the privacy and transfer registrations that go red without it | additive; `db:drift-check` green, the whole suite green, no existing table touched |
| 3   | `repo/groups.ts` and `services/membership.ts`: resolution, last-admin rules, create/leave/delete                             | pure TS behind no route                                                            |
| 4   | The five route files, validations, the invite flow, the rate-limit rule                                                      | new surfaces, nothing existing changes                                             |
| 5   | Phase 47: switcher, per-space tab state, the six capture paths, context and capability space-keying, section wiring          | the largest diff, and the one with no schema in it                                 |
| 6   | Phase 48: erasure hook and succession, deletion confirmation and notification, the Art. 15 predicate and its `scopeNote`     | closes tests 13b to 13e                                                            |
| 7   | Docs: `plan.md` §15 rows 46 to 48, `install.md`, `sharing.md`'s sibling section, `CHANGELOG.md`                              | text only                                                                          |
