# Phases 58 and 59: working on one item together, and the activity feed

**Scoped 2026-10-05.** The specification is [`plan.md`](./plan.md) §23.13 (phase 58) and §23.10 (phase 59), and it stays the specification. The route is
[`release-9-plan.md`](./release-9-plan.md)'s Branch 4, which already batches 57,
58 and 59 as one line of work. This document is the design: what the two phases
decide, where they depart from either of those and why, and what they
deliberately do not do. Where this document and §23 disagree, §23 wins and this
document is wrong.

Acceptance: tests 13j (phase 58), 13l and 13m (phase 59), and one this document
adds, 13o: **a `viewer` reaches no write path**.

## What earlier phases left for these two

Reconciled against the tree on 2026-10-05, not inferred from the plan.

- `rev Int @default(0)` is on seven models (`Area`, `Goal`, `Project`, `Task`,
  `Thought`, `Entity`, `Review`). It is written by nothing and read by nothing.
  `Review` has no `PATCH` at all.
- `ConflictError` (409) exists in `lib/api/errors.ts` and is already used for
  `last_admin`.
- Leaving already works end to end: `removeMember` in `services/membership.ts`
  handles self-removal, refuses the last admin, and deletes the group when the
  last member goes; `group-detail.tsx` has the button. Only the consequences are
  missing, and only one of them (assignments) has anything to act on yet.
- Two of the three emails exist: `group-deleted.tsx` (phase 48) and
  `group-budget-alert.tsx` (phase 50). "Your membership or role changed" does
  not; `changeMemberRole` only logs.
- `ResparkableEvent` already records the actor in `createdByUserId`, with
  `source: 'system'` for background runs, the `[spaceId, createdAt desc]` index a
  feed reads, and no index on the actor.
- Per-**file** upload limits exist (`resolveMaxDocumentBytes`, 25 MB default).
  There is no per-**space** total.
- `ResparkableComment` resolves through `resolveResparkableAccess`, whose bases
  are `owner`, `grant`, `grant-cascade`, `link` and `link-cascade`. `isOwner`
  requires `viewer.group === null`, so **a group member cannot comment on their
  own group's items today**: they fall through to the grant lookup and get
  `DENY`.

And one thing nothing said:

- **A group `viewer` can write.** `permissionsFor(role).write` is consulted by
  the grant, sharing, invite, comment, budget and admin services, and by nothing
  on the content path. `requestSpaceScope` checks membership and never role, so
  every `createCollectionHandlers` / `createItemHandlers` route, every bespoke
  `POST`/`PATCH`/`DELETE` under `app/api/v1/resparkable/`, `POST /capture` and
  every writing capability (reached through chat or an MCP key) accepts a write
  from a viewer. `release-9-plan.md` lists "a `viewer` cannot reach any write
  path" under Branch 2's verification; it was never asserted, and is not true.
  Phase 58's own "upload restricted to `member` and above" depends on it, so the
  fix lands first, in this branch.

## Decision 1: the viewer gate, at three chokepoints (13o)

A role that can read and not write is only real if every write path asks. The
tier has three ways in, and each gets one check rather than each route
remembering:

- **`requestSpaceScope`** refuses a non-`GET`/`HEAD` request from a scope whose
  role cannot write. It already has the request, and every content route already
  calls it. A route whose non-`GET` is genuinely a read passes
  `{ access: 'read' }` explicitly; the feed's "mark as seen" (Decision 8) is the
  only one, and it writes the viewer's own membership row rather than the space.
- **`POST /capture`**, which deliberately does not call `requestSpaceScope`
  (capture takes an explicit target, §23.4), checks the same predicate on the
  scope it resolves.
- **`ResparkableCapability.execute`**, the one place every capability call
  passes through, refuses a capability declared as writing when the scope cannot
  write. Each capability declares `writes: boolean`, abstract on the base class,
  so a capability added later cannot compile without answering.

**403, not 404.** §16.2's "not found, never forbidden" exists so a guess at an id
learns nothing. A viewer is a member: they can already see the space and every
item in it, so a 403 tells them nothing they do not know, and a 404 on an item
they are looking at would read as a bug.

Two refusals already existed and stay as they are: a viewer never comments
(phase 49) and never spends (phase 50's `assertCanSpend`), so chat was already
closed to them by the second.

## Decision 2: comments on the `space` basis

`resolveResparkableAccess` gains a sixth basis, `space`: the item lives in a
group space the viewer is a joined member of. Its permissions are read for
everybody, comment for anyone who can write the space, and `moderate` (delete
anybody's comment) for admins, which is what succeeds phase 13's "the owner".
Editing stays the author's alone.

The `space` basis is checked **before** the grant lookup, so a member who also
holds a grant on an item in their own group's space sees it as a member. The
basis carries the viewer's role from the scope minted at the boundary; no repo
query gains a membership term (D5).

What does **not** change: comments are still read by no embedding, context or
workflow path. §23.13 says a member's comment is _in scope_ for the group's
agent; that is a permission, and this phase does not build the reader. Doing so
would put third-party text in the agent's context for the first time, and that
deserves its own decision with the grant-into-the-group exclusion designed
alongside it.

## Decision 3: `rev` as an optimistic-concurrency token, opt in by the caller

Every update to a `rev`-carrying model increments it. A write **may** send the
`rev` it read; when it does, the update matches on it, and a mismatch returns
409 with the current row in `error.details.current`. When it does not, the write
is last-write-wins exactly as today.

**Optional, because the callers are not all people.** The capabilities, the MCP
tools and the iOS Shortcut all write through the same services and have never
read a `rev`; requiring it would break every agent write in the tier. The edit
forms, which are where two people meet one row, always send it.

The repo does `updateMany({ where: { id, ...spaceWhere, rev } })` and reads the
row back on a count of zero, which distinguishes "gone" (404) from "changed"
(409) without a second round trip on the happy path.

**The coverage list is asserted by enumeration** (13j): a test reads the Prisma
schema, collects every model with a `rev` field, and requires each to be either
in the handled list or in a named exclusions list with a reason. Today that is
six handled and one excluded (`Review`, which has no update route).

## Decision 4: assignment

`ResparkableTask.assignedToUserId String?`, FK to `"user"("id")` `ON DELETE SET
NULL`, hand-written in the migration like phase 45's `createdByUserId` and added
to probe B11, indexed `[spaceId, assignedToUserId]` for the "assigned to me"
filter.

- **The assignee must be a joined member of the space's group**, checked in the
  service against the scope's space, never inside a repo `WHERE`. In a personal
  space the only accepted value is `null`.
- **Leaving clears it.** `removeMember` nulls the leaver's assignments in that
  group's space in the same transaction that deletes the membership row, so
  nothing is silently reassigned. Erasure is already covered by the FK.
- **The filter returns rows and never a count.** The task list and board accept
  `assignedTo=me`; nothing renders "tasks per member".

## Decision 5: `ResparkableGroupAuditEntry`

Its own table, hanging off the group: `groupId` (cascades from the group),
`actorUserId` and `subjectUserId` (both nullable, FK `SET NULL`, so erasing either
person keeps the record of what happened and drops who), `action`
(`VarChar(32)`), `metadata Json?`, `createdAt`. Append-only: the repo has insert
and list, and nothing else.

Written **inside the transaction** of the action it records, so an action and
its record cannot disagree: role changes, removals (including self-leave),
settings changes, join-link minting and revocation, join approvals and
rejections, invitation issue and revocation, budget settings, member caps and
top-ups.

**Who reads it.** Admins see every entry. Any other member sees the entries
where they are the subject, because the subject of an administrative action has
a right to see it (§23.13). One route, `GET /groups/[id]/audit`, filtering by
role at the service, never by a repo `WHERE` shaped by membership.

It is a new `User` relation, so it goes into `SUBJECT_DATA_SOURCES` with an
export disposition, per CLAUDE.md: a subject receives the entries naming them as
actor or subject.

## Decision 6: one more email, "your membership changed"

`components/resparkable/emails/membership-changed.tsx`, sent to the person
affected when **somebody else** changes their role, removes them, or approves
their request to join. Not on a self-leave, an accepted invitation or anything
else the person did themselves, and not for any content activity. That keeps
§23.13's count at exactly three: group deleted, membership changed, budget
thresholds.

Sent after the transaction commits, through `sendEmail`, and a send failure is
logged, never surfaced: the change happened whether or not the email arrived.

## Decision 7: a per-space storage quota for group spaces

`ResparkableGroup.storageQuotaBytes BigInt?`, `null` meaning the default, 2 GiB.
Upload sums `ResparkableDocument.byteSize` in the space (archived documents
included, because their originals are still retained) and refuses an upload that
would cross the quota with 413 and a message naming both numbers. The group page
shows usage against the quota. Personal spaces keep today's behaviour: no total,
only the per-file cap.

The admin sets the number through the existing group settings `PATCH`. "Upload
restricted to `member` and above" needs no code of its own: it is Decision 1.

## Decision 8: the feed

- **Route.** `GET /api/v1/resparkable/feed` in the current workspace, group
  spaces only (a personal space 404s: a feed of your own actions is a history
  view, a different feature). Newest first, cursor-paged, an optional
  `member=<userId>` filter that returns rows and never a total. ETag via
  `computeETag` / `checkConditional`, so an unchanged feed is a 304.
- **Titles.** Each line names its item. The route resolves titles with one query
  per entity type on the page, never one per row. A deleted item renders without
  a title ("A task was deleted").
- **Unread.** `ResparkableGroupMember.feedSeenAt DateTime?`, returned with the
  page and set by `POST /api/v1/resparkable/feed/seen`, which writes only the
  caller's own membership row and so is the one non-`GET` a viewer may make
  (`{ access: 'read' }`, Decision 1). It decides styling, never a `WHERE` (13l
  compares the emitted SQL for a member who has read everything with one who has
  read nothing).
- **Rendering.** A pure `feedLine(event)` maps kind and entity type to a
  sentence whose subject is the item, with the person as attribution ("Chapter 4
  notes, added by Sam"), and returns `null` for anything it cannot render, which
  the view drops. `source: 'system'` renders as the workspace acting. No count,
  total, rate, ranking or sort by member appears anywhere (13m is a rendering
  test over the component, not a data test).
- **Tab.** A `feed` kind in `tab-registry.ts` and `change-scope.ts` (every
  collection, since anything can appear in it), offered by the Launcher only in
  a group workspace.
- **Polling.** A shared `useVisibilityPoll` hook: polls every 30 seconds while
  the document is visible and the tab mounted, stops when hidden, and polls once
  on becoming visible again. There is no polling in the tier today, so it is
  written once, for this and whatever comes next.

## What this does not do

- Push, presence or "Priya is editing this" (§23.14 q7).
- Read comments into the group agent's context (Decision 2).
- A feed for personal workspaces.
- Any email beyond the three.
- Require `rev` from agent or API writers (Decision 3).
- Personal-to-group promotion or cross-space search (§23.14 q1, q2).
- Phase 62's money: seats, splits, allowances, refunds on leaving.

## Commit order

1. The viewer gate, alone, with 13o. It is a fix and should be reviewable as one.
2. One migration: `assignedToUserId`, `ResparkableGroupAuditEntry`,
   `feedSeenAt`, `storageQuotaBytes`, with the hand-written FKs and drift probes.
3. Comments on the `space` basis.
4. `rev`.
5. Assignment, and leaving clears it.
6. The audit log and the membership email.
7. The storage quota.
8. The feed.
9. Docs: `plan.md`'s table, the tier `README.md`, `ui.md` step 6 for the new tab,
   `sharing.md`'s basis table (with the "who reads the thread" column
   `release-9-plan.md` asked for), `CHANGELOG.md`.
