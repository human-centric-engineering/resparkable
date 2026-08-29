# Release 9: Groups, the implementation route

**Scoped 2026-08-29.** The specification is
[`plan.md`](./plan.md) §23, §24.1 and §24.2, and it stays the specification. This
document is the route through it: how the nine phases split into branches, what
each one touches, the order the commits go in, and the places where the code has
moved on since §23 was written. Where the two disagree, §23 wins and this document
is wrong.

Same relationship to `plan.md` as [`phase-56-plan.md`](./phase-56-plan.md) has, one
release up: that one designs a single phase, this one sequences nine. Each branch
below still gets its own phase-level design doc before its schema is touched.

## Context

Resparkable's whole data model assumes one brain has exactly one human owner.
`ResparkableSpace.userId` is simultaneously the owner's identity, the row's
partition key, and the FK target for 23 satellite tables. The requirement that
prompted [`plan.md`](./plan.md) §23 breaks that assumption:
**a group should own a workspace exactly as an individual owns one today**,
capturing into it, writing in it, running agents against it, being billed for it,
sharing it with other groups, and seeing what the group has been doing.

The design is already specified. §23 (scoped 2026-08-25, extended 2026-08-29)
covers it in fourteen subsections, §24.1 and §24.2 cover the schema it shares
with Workspaces, §15 phases it as **Release 9** (phases 45 to 50 and 57 to 59),
and §16 gives thirteen acceptance tests (13a to 13m). Releases 1, 1.5 and 2, the
hard prerequisites, are all complete on `main`. **This plan is the implementation
route through that spec, not a re-specification of it.** Where this plan and §23
disagree, §23 wins and this plan is wrong.

The intended outcome: a group is a principal that owns a space; members read and
write the whole space with no per-item privacy tier; joining, working together,
seeing activity, and paying for it all exist; and nothing about one-person
Resparkable changes.

### The four things that make this large

1. **The key rename touches every table in the tier.** 23 satellites, 207
   `scope: OwnerScope` declarations across 35 `repo/**` modules, ~204
   `ownerWhere()` call sites, ~85 scope mint sites, ~300 test files.
2. **D5 must survive.** "Every brain query is either a space query or a shared
   query, and there is no third kind." Membership resolves **once**, where the
   scope is minted. `actorUserId` is never a `WHERE` term. The moment it is, a
   group space has a per-row ACL and forty list endpoints become potential leaks.
3. **`ResparkableGrant` generalises rather than forking.** Its grantee is an
   email address today, keyed `@@unique([entityType, entityId, granteeEmail])`,
   and a group has no address.
4. **Two surfaces are one `groupBy` away from being a productivity monitor**:
   §23.8's digest and §23.10's feed. The rule is asserted in tests (13h, 13m),
   not left to the prompt's manners.

---

## Shape of the work

Four branches, four PRs, four design docs. Phase 45 is reviewed alone because it
touches every table in the tier and a review that is also reading UI work will
not read it properly (§15).

| Branch                                      | Phases     | Design doc         | Ships                                           |
| ------------------------------------------- | ---------- | ------------------ | ----------------------------------------------- |
| `feature/resparkable-space-key`             | 45         | `phase-45-plan.md` | Nothing user-visible                            |
| `feature/resparkable-groups-core`           | 46, 47, 48 | `phase-46-plan.md` | A group exists, is safe, and is capturable-into |
| `feature/resparkable-groups-sharing-budget` | 49, 50     | `phase-49-plan.md` | Group-to-group grants, digest, budget           |
| `feature/resparkable-groups-collaboration`  | 57, 58, 59 | `phase-57-plan.md` | Joining, working together, the feed             |

Each design doc follows the `phase-56-plan.md` precedent: what it decides, the
departures from the spec and why, and what it deliberately does not do. Written
**before** the schema is touched, committed on the branch it describes.

`CHANGELOG.md` gets an `## [Unreleased]` entry per branch. Every one of these
changes a named seam or a published Prisma model interface, so all four qualify
under `VERSIONING.md`'s public-surface contract.

---

## Branch 1: `feature/resparkable-space-key` (phase 45)

**Ships behind no flag and changes no behaviour.** It is a rename plus some
nullable columns, and it carries Release 10's schema too (§24.1) so the tier's
largest tables are migrated once, ever. Nothing about groups is reachable until
phase 46. Design doc `phase-45-plan.md` first, before any schema is touched.

§15 says this ships "alone in its own reviewed commit". Read that as "not mixed
with any other phase": a branch of seven commits, squash-merged, satisfies it and
gives the reviewer a story. Say so in the PR description so nobody argues.

### Five things to settle before writing any SQL

Each was verified against the code, and each changes the shape of the work.

1. **`ResparkableSpace.id` is dead except for one log line.**
   `services/space.ts:83` logs `{ userId, spaceId: created.id }`, and that is the
   only occurrence of the identifier `spaceId` in the tree today. After this phase
   the name is a lie, because `spaceId` becomes the key column and not the PK.
   Rename it to `spaceRowId` in the same commit.

2. **"Zero rows rewritten" cannot include `framework_resparkable_space`.** The
   parent gains six columns and a backfill. State the invariant as: zero writes to
   the 23 satellites, exactly one write per existing space row on the parent.
   Otherwise the assertion is unwritable. The backfill must also set
   **`isDefault = true`**, which §23.2 omits: without it every existing user ends
   up with no default workspace, which §24.2 forbids outright.

3. **`ResparkableJob`'s docblock is wrong about its own future.** The schema
   comment says that after phase 45 it "relates to `ownerUserId`". It cannot:
   `ownerUserId` is deliberately non-unique and a Postgres FK requires a unique
   target. Phase 45 renames `job.userId` to `spaceId` mechanically like the other
   22 and leaves the FK on `ResparkableSpace.spaceId`. Re-keying the queue to the
   owner is phase 51 (W2) work. Amend the docblock in this commit, because leaving
   it guarantees the next reader implements the wrong thing.

4. **§23.2's role invariant contradicts the sharing layer.** It says a
   `SpaceScope` for a `kind: 'personal'` space is always `owner`. But
   `access/resolve.ts:413` and `:444` mint scopes on _someone else's_ personal
   space for a grantee, and those must be `viewer`. Restate the invariant as the
   exclusion §23.2 actually wants: **`owner` never appears on a `kind: 'group'`
   space**, and a non-`owner` role on a personal space arises only from
   `access/**`.

5. **`actorUserId` must be `string | null`.** `ResparkableViewer.userId` is
   nullable (`access/types.ts:64`) because an anonymous public-link reader has no
   account. Document the null as "anonymous public-link reader". It is never a
   filter, so the nullability cannot reach a `WHERE`.

### Why the rename is cheap, and the one thing that makes it so

Every satellite relates to the space **by user id**, not by space id:

```prisma
space ResparkableSpace @relation(fields: [userId], references: [userId], onDelete: Cascade)
```

`ResparkableSpace.userId` is `@unique` and is the FK target for all of them, and
nothing references `ResparkableSpace.id`. So a personal space keeps its existing
key value, which happens to be a user id, and a group space gets a cuid.
Re-pointing the satellites at `ResparkableSpace.id` instead would mean an `UPDATE`
over every row in the brain, on the table set that is by design the largest thing
in the database.

`ALTER TABLE … RENAME COLUMN` updates `pg_attribute.attname` and nothing else. It
does not touch `attnum`, so every index and FK keeps working and keeps its old
name, and no heap or index page is touched. The two `GENERATED` tsvector columns
are out of the blast radius entirely: `task.searchVector` derives from
`title || notes` and `embedding.searchVector` from `content`, and neither reads
`userId`. `ADD COLUMN … NOT NULL DEFAULT <constant>` is metadata-only on PG 11 and
later, so put a hard version guard at the top of the migration.

### What changes

1. **`ResparkableSpace.userId` becomes `spaceId`** (still `@unique`), and the
   `userId` column becomes `spaceId` on every satellite. **Generate the satellite
   list from the schema** (`space ResparkableSpace @relation(...)`), not from
   §23.2's prose: the section says 21 and there are 23.

2. **`ResparkableSpace` gains `kind` (`personal | group`) and
   `ownerUserId String?`**, indexed and deliberately **not** `@unique`. That
   absence is the feature (§24.1) and needs a comment saying so, or somebody later
   adds the constraint as a tidy-up. The hand-written
   `→ "user"("id") ON DELETE CASCADE` FK moves to `ownerUserId`.

3. **§24.1's columns in the same migration**: `isDefault`, `name`, `slug`,
   `archivedAt`, plus a **partial unique index**
   `WHERE "isDefault" AND "archivedAt" IS NULL`. Partial uniques are not
   expressible in Prisma, so this becomes the tier's tenth raw-SQL object and gets
   its own probe, **B10**. `idx_ai_knowledge_base_single_default` (probe A7 in
   `.context/database/prisma-unmodelled-objects.md`) is the exact precedent.
   `ownerUserId` is nullable and NULLs never collide in a unique index, so group
   spaces are unconstrained here by design; phase 46 adds the `groupId` sibling.

4. **`ResparkableGroup.spaceId` loses its `@unique`** too, at the same time and
   for the same reason. Keep "one group, one space" as a service rule in phase 46
   (§23.14 q6 stays open).

5. **`createdByUserId String?` on every satellite** (§23.5), FK to `"user"("id")`
   `ON DELETE SetNull`. **This is a deviation from §15's phase-45 row, which does
   not list it. Take it deliberately and record it in the design doc.** The
   reasoning is phase 45's own: it is 23 more nullable columns on the same 23
   tables, and the point of this phase is that the tier's largest tables are
   migrated once, ever.

   `SetNull` rather than `Cascade` is the point. When a member is erased their
   _authorship_ disappears and the group's content stays, because that content is
   the group's. Note the asymmetry with `ResparkableComment.authorUserId`, which
   genuinely cascades (probe B9): **authored rows in a group space survive erasure,
   comment bodies do not.** One is the group's record, the other is a person's
   words.

   Cost to be honest about: 23 more FKs Prisma cannot model, so they need drift
   coverage. Write **one parameterised probe over the table list**, not 23 probes.

   On `ResparkableEvent` the column means the **actor**, not the item's author
   (§23.10), and the schema comment must say so, because the name invites the wrong
   reading.

6. **The schedule scope key, written additively.** `RESPARKABLE_SCHEDULE_OWNER_KEY`
   gains a sibling `resparkableSpaceId` rather than being replaced. Migrations run
   at deploy, before the new code is on every pod, and a destructive rewrite opens
   a window where an old reader finds nothing and silently resolves no owner: a
   skipped bill, or a 04:30 briefing where every capability throws with nothing
   surfacing it. That is exactly what
   `20260805120000_resparkable_schedule_owner_scope`'s header was written about.
   Keeping both keys closes it, makes "a pre-migration row still resolves" trivially
   true, and leaves a one-line cleanup for a later phase. All three `jsonb` columns
   get the update: `ai_workflow_schedule`, `ai_workflow_execution`,
   `ai_workflow_trigger`.

   Three readers, funnelled through one new `readScheduleSpaceId()` helper that
   accepts either key: `jobs.ts:147`, `capabilities/base.ts:84`, and **raw SQL** at
   `repo/billing.ts:219`. Note that `e."userId"` in that statement is
   `ai_workflow_execution.userId`, a core column that does **not** get renamed. Not
   every `"userId"` in the tier's raw SQL belongs to the tier.

7. **`OwnerScope` becomes `SpaceScope`** in `repo/space-scope.ts` (a `git mv`):
   `{ spaceId, actorUserId: string | null, role: SpaceRole }`.

8. **Drift probes.** B1 rewritten to assert the FK on `ownerUserId`, by
   definition and not by mere existence, plus a paired forbidden probe that
   `framework_resparkable_space_userId_fkey` is **gone** (one line via the existing
   `absent()`, and it catches a half-applied migration). B10 added, asserting
   `pg_indexes.indexdef` contains `CREATE UNIQUE INDEX`, `("ownerUserId")` and the
   predicate: `indexExists` alone would pass on a plain non-unique non-partial
   index of the same name, which is the identical silent failure
   `generatedColumnExists` was written to close. **Read the normalised predicate
   text off the database once and pin that string**; Postgres reformats predicates.
   Both need new `constraintDefMatches` / `indexDefMatches` helpers beside
   `columnHasType`.

   While there: the schema header says "SIX Postgres objects" and
   `lib/app/db-drift.ts` says "six unmodellable objects". Both are stale, the file
   already registers nine, and this makes ten.

9. **ESLint boundary comments and paths** in `lib/framework/eslint.config.mjs`,
   with `access/eslint-d5-boundary.test.ts` following.

### The migration file

Hand-edited, `prisma/migrations/<round-timestamp>_resparkable_space_key/migration.sql`.
Generate with `--create-only`, then rewrite. **Prisma renders column renames as
drop-then-add, which here would silently empty the brain.** That is the single most
dangerous line in the release and the reason this migration is reviewed alone. The
header block enumerates every scrubbed statement, as
`20260728232937_resparkable_space_cascade` does.

Prisma wraps each migration in a transaction on Postgres, so it is all-or-nothing,
which also means **no `CREATE INDEX CONCURRENTLY`**. The partial unique is a plain
`CREATE UNIQUE INDEX` and is cheap: one row per user.

Statement order:

1. Drop the old B1 FK. It is being _moved_ to another column, and a constraint
   cannot be moved by rename.
2. Rename the parent key. Every satellite FK follows automatically.
3. Rename the column on all 23 satellites.
4. Rename the ~56 indexes.
5. Rename the 23 satellite FK constraints (catalog-only, no revalidation scan).
6. `ADD COLUMN` for the six new space columns and `createdByUserId` on the
   satellites.
7. The one backfill: `ownerUserId = "spaceId"`, `kind = 'personal'`,
   `isDefault = true`.
8. Re-add B1 on `ownerUserId`, **after** the backfill or validation fails. It
   cannot fail on real data, because the FK dropped in step 1 already guaranteed
   every key value is a live user id.
9. The plain index on `ownerUserId`.
10. B10, the partial unique.
11. The additive schedule-scope updates.

**Do not hand-derive the new index names.** Several are already at or past
Postgres's 63-character limit and were silently truncated:
`framework_resparkable_embedding_userId_entityType_entityId_chun_key` (67 as
written), `framework_resparkable_comment_userId_entityType_entityId_createdAt_idx`
(70), `framework_resparkable_link_userId_sourceType_sourceId_targe_key`. Going from
`userId` to `spaceId` adds a character and shifts the truncation point. **Harvest
the exact target names from Prisma itself**: run `--create-only` against a shadow
DB with the renamed schema, read the `DROP INDEX` / `CREATE INDEX` pairs it
generates, transcribe the _created_ names into `ALTER INDEX … RENAME TO`, then
throw the generated file away. Same trick for the FK names. This is the difference
between a twenty-minute step and a two-hour one.

Two related facts: all the `_key` objects here are plain unique **indexes**, not
unique **constraints** (`20260728222816_add_second_brain/migration.sql:387+` emits
`CREATE UNIQUE INDEX`), so `ALTER INDEX … RENAME TO` is correct and there is no
`pg_constraint` row to chase. And getting the names right is not cosmetic: leave
them and Prisma concludes the objects are misnamed, injecting phantom renames into
**every future migration**, which the next person scrubs incorrectly. That failure
is already documented in `.context/database/prisma-7-baseline-bugs.md`.

### Staging the type rename, and the honest answer to test 13a

The measured blast radius: 207 `scope: OwnerScope` declarations in `repo/**`, 219
`ownerWhere()` / `liveOwnerWhere()` call sites, 84 `ownerScope(` mint sites across
58 files, and 117 of the tier's 178 test files mentioning `userId` (474
occurrences of `userId:`).

**Use a transitional `@map` so the irreversible commit has no code churn.** Four
combinations exist; ship **Prisma field `spaceId` on DB column `spaceId`, no
`@map`**, and pass through **field `userId` `@map("spaceId")`** on the way. A
permanent `@map` in either direction is rejected: raw SQL, `psql`, `EXPLAIN`, drift
probes and index names would all disagree with the code, which is the
drift-by-naming this codebase writes paragraphs to prevent.

The transitional state earns its keep because it **decouples the irreversible half
from the churny half**. The migration commit then carries the whole SQL file, six
new Prisma fields and one `@map` per model, with **zero TypeScript and zero test
changes**, so the entire existing suite runs as an unmodified control over the
migrated database. That is precisely the evidence test 13a is reaching for, and it
is only available if the field rename is a separate commit.

Two things to check in the first ten minutes, because the staging depends on them:
that Prisma derives default index and constraint names from the mapped **column**
names rather than the field names (verify with
`prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code`), and
that `prisma format` is happy, since there is no field-level `@map` anywhere in
`prisma/schema/` today.

The rename then splits into two genuinely independent renames that people
conflate: **the scope type** (`OwnerScope` to `SpaceScope` and friends), which is
pure identifier churn and changes no Prisma argument shape, so it breaks **zero**
assertions; and **the Prisma field**, which changes the object handed to Prisma and
therefore breaks every assertion that reads it. Do the first with a deprecated
alias bridge, then delete the aliases, then do the second.

**Test 13a is not achievable as worded, and the PR should say so rather than fudge
it.** It asks for "every pre-existing test passes with no edit beyond the
`OwnerScope` to `SpaceScope` rename". The tier's tests mock Prisma and assert the
argument object: `isolation.test.ts:336` reads `where?.userId`, `:378` matches
`/"userId"\s*=/` against raw SQL, `:575` uses `toEqual({ id, userId: 'user_a' })`.
A field rename is by construction visible to a suite whose contract under test _is_
the argument shape. The only way to satisfy 13a literally is a permanent `@map`,
which is the wrong trade.

**Replace the prose with a machine-checkable property that is strictly stronger.**
A throwaway `scripts/framework/resparkable/assert-mechanical-diff.ts`, run once in
review rather than kept in CI, reads the branch's `tests/` diff and asserts that
for every changed line the removed and added text are identical after applying the
token substitution set, that per-file counts of `expect(` / `it(` / `describe(` are
unchanged, that no `.skip` / `.todo` / `.only` appeared, and that **no string
literal changed**. That last clause is why it works: the migration changes no
values, only names, because `spaceScope('user_a')` produces the same `spaceId`
value `ownerScope('user_a')` did. Propose the reworded 13a in `plan.md` §16 as part
of the commit.

The residual risk is reviewer fatigue on a thousand-line diff, and the script is
the mitigation: it lets the reviewer read the four substantive commits carefully
and take the two mechanical ones on the script's word.

**Drive the codemod with the compiler, not with regex.** Do not regex `userId:`;
most of the 474 hits are session ids, `withAuth` mocks and
`CapabilityContext.userId`. In `lib/**`, rename by symbol with ts-morph off
`space-scope.ts`'s exports, then let `tsc --noEmit` find every field site once the
`@map` is dropped, because `Prisma.ResparkableTaskWhereInput` stops accepting
`userId`. The compiler will **not** see raw SQL or `transfer/policy.ts`'s 22
`ownerColumn: 'userId'` string literals: handle those by hand. In `tests/**` the
mocks are untyped `vi.fn()`s, so nothing is compiler-visible. Run the suite, let it
fail, fix file by file, and gate it with the mechanical-diff script. 117 files, each
a one-key change: budget half a day.

Five files hold raw SQL touching the renamed column: `repo/jobs.ts` (the SKIP
LOCKED claim and five others), `repo/embeddings.ts` (seven statements),
`repo/events.ts:112`, `repo/billing.ts:206-219`, and `db-drift.ts`.
`search/hybrid-search.ts` has none: it delegates to `repo/embeddings.ts`.

### `role` and `actorUserId` at the 84 mint sites

**Keep the one-string constructor.** `spaceScope(userId: string)` returns
`{ spaceId: userId, actorUserId: userId, role: 'owner' }`, so all 84 sites are a
pure identifier rename with no argument added anywhere. That is the whole trick for
keeping this mechanical.

Add a second, explicit constructor for the two non-personal mints and for phase 46:
`spaceScopeFor({ spaceId, actorUserId, role })`. The two access-layer mints in
`access/resolve.ts` become `sharedSpaceScope(result, viewer)` and
`grantSpaceScope(grant, viewer)`, both `role: 'viewer'`. They need the viewer
threaded in, because `ResparkableAccessResult` carries `ownerId` but no viewer, so
that is a signature change at a handful of call sites. **Do not unify `LiveGrant.role`
with `SpaceRole`**: map `'commenter'` to `viewer`, because comment permission
already lives on `result.permissions.comment` and putting it in `role` too creates a
second source of truth that will drift.

Assert the invariants in the constructors and nowhere else. `spaceScope()` always
produces `role: 'owner'` with `actorUserId === spaceId`; `spaceScopeFor()` throws on
`role === 'owner'` with a null actor. And since `role` is inert in phase 45 (nothing
branches on it), **make "`actorUserId` is never a query filter" structural rather
than a comment**: extend `repo/isolation.test.ts`'s existing `SCOPED_CALLS` sweep
with a second assertion that no recorded Prisma argument's `where` contains
`actorUserId` at any depth, and that the raw-SQL sweep never binds it. That table
already enumerates every export, so it is three lines.

`capabilities/base.ts:84`'s `requireResparkableUser` becomes
`requireResparkableSpace`. After phase 45 the value it returns is nominally a
_spaceId_ while `context.userId` is a _user id_: identical today, divergent in
Release 10. Leave a `TODO(release-10)` naming that exactly.

### Commit order

The load-bearing property: **commit 2 is the only irreversible one and it has no
code churn; commit 6 is the only churny one and it has no DB risk.**

| #   | Commit                                                                                                                                                                                                                                                                                 | Why it is green                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `scripts/framework/resparkable/key-migration-checksum.ts`, read-only                                                                                                                                                                                                                   | adds nothing to the runtime                                                                                                           |
| 2   | **The migration.** The SQL file in full; six new fields plus `@@index([ownerUserId])` plus `@map("spaceId")` on 24 fields; B1 rewritten, B10 added, the two new probe helpers; `model-graph.generated.ts` regenerated; `prisma-unmodelled-objects.md` and the schema header updated    | **zero TS, zero test changes.** The whole suite is the control. `db:drift-check` green, checksums equal, `migrate diff --exit-code` 0 |
| 3   | Schedule scope key: the new constant, `readScheduleSpaceId()` accepting both keys, the three readers, new tests                                                                                                                                                                        | pure TS; the existing tests become legacy-key coverage and pass unchanged                                                             |
| 4   | `git mv owner-scope.ts space-scope.ts`; `SpaceScope` / `SpaceRole` / `spaceScope` / `spaceWhere`; deprecated aliases exported                                                                                                                                                          | one file changes; `spaceWhere()` still returns `{ userId }` under the `@map`                                                          |
| 5   | Codemod all 207 + 219 + 84 sites off the aliases; delete the aliases; the two access mints gain a viewer argument                                                                                                                                                                      | pure identifier rename, no argument shape changes, no assertion changes                                                               |
| 6   | **The field rename.** `@map` dropped, fields renamed, `references: [spaceId]`, `spaceWhere()` flips to `{ spaceId }`, five raw-SQL files, `transfer/policy.ts`'s 22 `ownerColumn`s, `repo/subject-export.ts`, the two schema-scanning guards' regexes, `repo/space.ts`, 117 test files | **no migration in this commit**: the DB column is already `spaceId`, so every failure here is a real code bug                         |
| 7   | Docs: `plan.md` §15 row and §16's reworded 13a, the `ResparkableJob` docblock, `install.md`, the ESLint boundary comment, `CHANGELOG.md`                                                                                                                                               | text only                                                                                                                             |

### Proving it lossless

`scripts/framework/resparkable/key-migration-checksum.ts`, run against a **restored
production-shaped dump** and not an empty dev DB. Emits JSON; run before, migrate,
run after, diff.

Per satellite table, auto-detecting the key column from
`information_schema.columns` so one script works on both sides, with `TimeZone`,
`DateStyle` and `extra_float_digits` pinned so float and `halfvec` rendering is
stable:

```sql
SELECT count(*)::bigint AS rows,
       coalesce(md5(string_agg(h, '' ORDER BY h)), '') AS checksum
  FROM (SELECT md5(t.*::text) AS h FROM "framework_resparkable_task" t) s;
```

`t.*::text` renders **positionally** and `RENAME COLUMN` preserves `attnum`, so the
digest is invariant under the rename by construction, which is exactly the property
wanted. Order by the hash rather than by `id`: order-independent and needs no id
column. `framework_resparkable_space` needs an explicit `ROW(...)` of its
pre-existing columns, since it legitimately gains six.

**A checksum alone is not enough: it passes on a full rewrite too.** Three sharper,
falsifiable assertions:

1. **`pg_class.relfilenode` unchanged** for every `framework_resparkable_*` table
   _and index_. A rewrite always changes it; a rename and a metadata-only
   `ADD COLUMN` never do.
2. **`pg_stat_user_tables` deltas**: `n_tup_upd + n_tup_ins + n_tup_del` is 0 for
   all 23 satellites and equals the space row count on the parent. Snapshot both
   sides with no `pg_stat_reset` between.
3. **`pg_total_relation_size`** within noise for the satellites.

Then five independent lines of evidence, all worth listing in the PR body: commit
2's diff contains no `.ts` outside `db-drift.ts` and the generated model graph and
the full suite passes on it unmodified; the mechanical-diff script over commits 5
and 6; the counts, checksums, relfilenodes and tuple deltas; `db:drift-check` exit 0
either side plus `migrate diff --exit-code` 0 after; and the real-DB smokes:
`smoke-isolation` (the one that caught the original missing cascade), `smoke-search`
(proves B4, B5 and B6 survived), `smoke-queue` (proves the SKIP LOCKED claim still
parses), and `scripts/smoke/erasure.ts` plus `export.ts`, which prove the **moved
B1 cascade still erases transitively**. That last one is the most important runtime
check in the phase.

### How this goes wrong, ranked

1. **The migration silently drops a raw-SQL object.** Highest, because it has
   already happened twice here (both `20260728232937` and `20260825120000` headers
   document it) and every failure is silent: a dropped `GENERATED` column does not
   error, it just stops populating, and search returns nothing for new rows while
   old rows still match. This migration touches every table in the tier, so the
   scrub list will be the longest yet. _Mitigation:_ enumerate every scrubbed
   statement in the header; `db:drift-check` immediately before and after; B10
   guarded from its first minute; run against a restored dump so the tsvector
   columns' _population_ is observable and not just their metadata.

2. **Something rewrites the tier's biggest tables and nobody notices.** The whole
   justification for this design is "zero rows rewritten", and a checksum-only
   assertion would let the invariant be claimed without being held. You would
   discover it as a multi-hour deploy lock on the first large install.
   _Mitigation:_ the relfilenode and tuple-delta assertions, not the checksum. Every
   `ADD COLUMN` takes a constant default. No `SET DEFAULT` on any satellite. A hard
   PG-version guard at the top of the migration.

3. **Prisma refuses to stay quiet afterwards.** The truncated index names and the
   23 FK names must land on Prisma's exact derived defaults, or the next person's
   unrelated migration arrives carrying 56 objects of churn, which they scrub
   incorrectly, which is failure 1 again one migration later. _Mitigation:_ harvest
   names from Prisma's own output; gate the branch on `migrate diff --exit-code` 0;
   verify the field-versus-column naming basis in the first ten minutes.

4. **A guard goes green while guarding nothing.** Two schema-scanning tests key off
   the literal string `userId`.
   `tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts` matches
   `/^\s*userId\s+String/` and has a guard-on-the-guard
   (`expect(scoped.size).toBeGreaterThanOrEqual(15)`), so it goes **red**, which is
   correct and a one-line fix. `tests/unit/lib/privacy/export-sources.test.ts` has
   **no such guard**: its `USER_SCALAR_FIELD` regex is
   `/^\s*(userId|createdBy|uploadedBy|ownerId|actorUserId|subjectUserId)\s+String/`,
   so after the rename all 24 Resparkable models stop matching, its 24-entry
   `HANDLED_OUTSIDE_MANIFEST` block becomes dead weight, and the privacy coverage
   check for the tier goes quietly vacuous. Meanwhile `ownerUserId`, a genuine
   hand-written FK to `User`, matches neither that regex nor `OWNERISH_NAMES` in
   `prisma/generators/portability.mjs`. _Mitigation:_ add `ownerUserId` to both
   sets, add a guard-on-the-guard to `export-sources.test.ts` mirroring the tier's,
   and assert `scoped.size` again after the rename.

5. **Account transfer breaks on import, invisibly.** `lib/portability/apply-import.ts`
   does `write[policy.ownerColumn] = targetUserId`. After the rename
   `ownerColumn: 'spaceId'` still writes the target user's id into `spaceId`, which
   is correct, but `ownerUserId` is **not** in the `ResparkableSpace` policy's
   reset/mint sets, so an imported space carries the _source_ user's `ownerUserId`.
   That either violates the new B1 FK outright or, worse, installs an
   `ON DELETE CASCADE` from a stranger's account onto the importing user's whole
   brain. Nothing in the existing policy covers it, because the column does not
   exist yet. _Mitigation:_ add `ownerUserId` to that policy's owner-rewrite
   handling in commit 6 and cover it in the transfer smoke path. Call this one out
   to the reviewer by name: it is invisible in the diff unless you know the import
   engine's contract.

## Branch 2: `feature/resparkable-groups-core` (phases 46, 47, 48)

The point at which a group workspace exists, is safe, and cannot be captured into
by accident. Design doc `phase-46-plan.md` first.

### Phase 46: the group and its members

**Schema** (`prisma/schema/framework-resparkable.prisma`), two new tables, both
`framework_resparkable_`-prefixed and both **outside the D1 cascade**, because
they describe the relationship rather than the brain:

- `ResparkableGroup`: `id`, `name`, `slug @unique`, `description`, `spaceId`
  (its workspace; §24.1 removed the `@unique` in phase 45, so keep "one group,
  one space" as a service rule per §23.14 q6), `maxMembers Int @default(50)`,
  `createdAt`.
- `ResparkableGroupMember`: `groupId`, `userId`, `role`, `invitedByUserId`,
  `joinedAt`, `@@unique([groupId, userId])`.

`ResparkableGroupMember.userId` is a **new `User` relation** and therefore carries
both CLAUDE.md obligations, landed in this phase and not after:

1. `onDelete: Cascade`. Losing your account removes your memberships, not the
   groups. This is a hand-written FK for the same reason B1 and B8 are
   (Resparkable must not add a relation field to the Sunrise-owned `User`), so it
   needs a **new drift probe** in `lib/framework/resparkable/db-drift.ts`
   alongside B1, B8 and B9.
2. A registration in the export manifest. Because neither table carries a space
   key, they are **not** covered by
   `lib/framework/resparkable/repo/subject-export.ts`'s space-scoped collector.
   They belong in `lib/privacy/export-sources.ts` proper, reached through
   `lib/app/data-export.ts`. `tests/unit/lib/privacy/export-sources.test.ts` fails
   until they are listed, and no row is ever deleted to make it pass.

**`transfer/policy.ts` dispositions** in the same phase, explicit rather than
inherited: a group space is **not transferable with an account** (§23.6). Taking
your account elsewhere does not take a shared workspace with you.

**`SpaceScope` minting for a group** is the whole trust boundary. One new service,
`lib/framework/resparkable/services/membership.ts`, resolving
`(actorUserId, spaceId)` to `SpaceScope | null` in one indexed query, and this is
the **only** place membership is read on a request path. `spaceScope()` stays
greppable as the complete list of trust boundaries, exactly as `ownerScope()` is
today.

**Last-admin rules** (§23.3), in the service and not the route: the last admin
cannot leave, be demoted, or be removed; erasing the last admin transfers the role
to the longest-standing remaining member; a group with no members at all is
deleted rather than left as an unreachable space holding rows. Precedent for the
transfer rule is §18's circle-ownership rule, same reasoning and same shape.

**Routes**, hand-written and modelled on
`app/api/v1/resparkable/grants/route.ts` rather than generated by
`createCollectionHandlers` (which hard-codes `ownerScope`):

```
GET  POST         /api/v1/resparkable/groups
GET  PATCH DELETE /api/v1/resparkable/groups/[id]
GET  POST         /api/v1/resparkable/groups/[id]/members
PATCH DELETE      /api/v1/resparkable/groups/[id]/members/[userId]
POST              /api/v1/resparkable/groups/[id]/members/[userId]/invite
```

Invites reuse the **shape** of §13's grant invites: sha256 `inviteTokenHash`,
`randomBytes(24).toString('base64url')`, the 30-day default and 365-day max
`grantExpirySchema` window, `isShareActive` from `lib/utils/share-window.ts`, an
identical response whether or not the address has an account, and never
`Verification`. `lib/framework/resparkable/services/invites.ts` is the model to
copy, and the `resparkable-invite` 20/day tier in
`lib/framework/resparkable/rate-limit.ts` is the cap to reuse.

### Phase 47: the switcher, and capture that names its target

§23.4's two consequences are UI obligations, and this is the phase that pays them.

**The space switcher lives in the shell header, not the tab strip** (§24.2).
`components/resparkable/shell/app-header.tsx` is the one piece of chrome always on
screen, so the switcher goes in its right cluster. Keyboard-reachable, with the
active space **in the URL** so a space is a link and browser-back works, and
personal and group spaces in the same switcher grouped and labelled by kind. Tab
state is per space and retained across a switch: `workspace-context.tsx` already
persists per surface under `resparkable.workspace.v2`, and the key gains a space
segment.

**Capture always names its target space, and the default is always personal.**
Six paths, each with its own entry point, each asserted separately (test 13e). A
thought landing in the group brain because the last-used space was sticky is the
mortifying failure mode this feature has.

| Path              | Entry point                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| Quick capture     | `POST /api/v1/resparkable/capture`                                                |
| PWA share target  | the same route, via `/resparkable/capture`                                        |
| Email inbox token | `capabilities/capture-for-token.ts` (already per-space: the token _is_ the space) |
| Voice             | `POST /api/v1/resparkable/transcribe`                                             |
| Image             | `POST /api/v1/resparkable/transcribe/image`                                       |
| Sparkey composer  | the `resparkable_capture_thought` capability                                      |

`ResparkableThought.sensitivity` (Release 8) becomes a **warning at the point of
capture** in a group space ("this looks personal, are you sure it belongs in Study
Group B?"), never a filter. Repurposing it as access control builds the per-row
ACL §23.4 forbids through a side door.

**Agents and context follow the space, not the actor** (§23.9). Sparkey is a
permanent pane, so the moment a member opens a group space the agent layer is live
and this cannot wait for phase 50:

- `loadResparkableContext` in `lib/framework/resparkable/context/contributor.ts`
  today "ignores `id` and reads `request.userId`", specifically so a shared cache
  partition cannot leak another user's goals. It reads the **space** id instead,
  which is the correct partition once a space has several members, with the same
  guarantee by the same mechanism. `buildContext` caches on `type:id:userId`, so
  the key must carry the space or two members get two entries for identical
  content. Changing the key is safe _only because_ the content is now
  space-derived, and the docblock has to say that or the next reader will assume
  the old leak. `app/api/v1/resparkable/chat/stream/route.ts` pins both `userId`
  and `contextId` server-side today; `contextId` becomes the resolved space id and
  stays pinned.
- `requireResparkableUser` (`capabilities/base.ts:83`) becomes
  `requireResparkableSpace`, and write capabilities refuse a `viewer`. **No
  capability accepts a `spaceId` as an LLM-supplied argument**, for exactly the
  reason none accepts a `userId` today: every `agent*Schema` in `validations.ts`
  is `.strict()` and has no such field, and
  `tests/unit/.../capabilities/scope.test.ts` sweeps every handler.
- **A member's text can now reach another member's agent turn.** This is a new
  prompt-injection surface, and inside one group it is **accepted rather than
  eliminated**: a shared brain whose shared agent cannot read it is not a shared
  brain. The mitigation is §18.7's, that the agents reading group content have no
  destructive capabilities bound, asserted at the seed level so a later binding
  cannot undo it.

**New section wiring.** A `/resparkable/groups` surface means the checklist from
`ui.md`: `ui/routes.ts`, `ui/nav-groups.ts`, `ui/section-help.ts` (its coverage
test fails otherwise), `ui/workspace/tab-registry.ts`, a
`workspace/tabs/groups-tab.tsx` adapter, a `ui/payloads.ts` schema, an
`api/endpoints.ts` entry, and `ui/workspace/change-scope.ts` keys.

**Reuse, don't rebuild.** The grants half of
`components/resparkable/share/share-dialog.tsx` already _is_ an
invite-a-person-with-a-role form; `my-shares-view.tsx` is the list-with-revoke
pattern with optimistic remove and rollback; `accept-invite.tsx` plus
`app/(resparkable)/resparkable/invite/[token]/page.tsx` is the whole token to
session to bind to redirect flow.

### Phase 48: erasure and isolation

The case that gets got wrong here is not "delete a group", it is "erase a member
of one" (§23.6).

- **Probe B1 extended to assert both halves**: the FK exists with
  `ON DELETE CASCADE` on `ownerUserId`, **and** every `kind: 'group'` space has
  `ownerUserId IS NULL`. A group space that acquires an `ownerUserId` through some
  future convenience is a whole shared workspace that vanishes when one person
  closes their account. Assert it as a schema-level invariant, a `CHECK`
  constraint plus the probe, not only in a test fixture.
- **Member-erased hook** in `lib/framework/resparkable/privacy/erasure.ts`, for
  admin succession where the erased member was the last admin. Everything else is
  database constraints: memberships cascade, `createdByUserId` nulls out, and the
  group space is untouched because it has `ownerUserId = null` and is therefore
  not reachable by the personal cascade at all.
- **Group deletion** is admin-only, cascades the space and everything in it, and
  is gated behind the explicitness §13 demands for a never-expiring share link: a
  typed confirmation naming the group, plus a notification to every member. It is
  **not** offered as a menu item next to "leave group".
- **Art. 15 export gains a predicate.** A subject's export contains their personal
  spaces in full, plus their group memberships, plus rows in group spaces where
  `createdByUserId` is them. This is the first source in the tier whose correct
  disposition is a predicate rather than "all rows for this user", and the seam
  already exists: `SubjectDataSource.scopeNote` in `lib/privacy/export-sources.ts`
  is the field for saying which rows a source withholds and why, surfaced in the
  export's own `meta`. Use it. A source that narrows without one is the
  silent-omission failure the manifest exists to prevent.

Tests 13b to 13e. 13b is the single most important assertion in the release.

---

## Branch 3: `feature/resparkable-groups-sharing-budget` (phases 49, 50)

Design doc `phase-49-plan.md` first.

### Phase 49: group-to-group sharing

§13's grant model **generalises rather than gaining a parallel mechanism**. Half
the work is already done by phase 45: `ResparkableGrant.userId` is a satellite key
and becomes `spaceId`, which is §23.7's `grantorSpaceId`. What is new is the
grantee side.

- Add `granteeSpaceId String?` beside `granteeUserId` and `granteeEmail`. The
  email-invite path is **retained** as the way an unaccepted grant addresses a
  person who does not yet have a space to receive it. A personal-to-personal grant
  is then the special case it always was.
- `granteeClauses()` in `lib/framework/resparkable/access/store.ts` gains a third
  clause. Two properties must survive: it still returns `null` for an
  identity-less viewer (an unfiltered `OR: []` matches every grant in the
  install), and the group clause folds into the **existing** grant query, because
  the four-query budget of `resolveResparkableAccessMany` is a hard requirement
  rather than an optimisation.
- Revisit `@@unique([entityType, entityId, granteeEmail])`. Today "one grant per
  address per item" is what makes "what can Bob do" single-valued. With a group
  grantee the answer becomes "the strongest of his direct grant and his groups'
  grants", which is what `best()` and `rank()` in `access/resolve.ts` already
  compute for overlapping grants. Extend that rather than adding a rule.
- `resolveResparkableAccess`'s **owner short-circuit** is the one line a group
  changes. `viewer.userId === ownerId` no longer covers a group member, so it
  becomes a space-membership check resolved from the scope already minted at the
  boundary, never a fresh query inside the resolver.
- **The redaction set stays subtractive and basis-keyed.** A `space` basis
  (§23.13's comments) and, if needed, `grant` / `grant-cascade` reached through a
  group, are the natural extensions. Do **not** add a role dimension to
  `redactionsFor()`: that breaks the "fails closed on a field nobody has thought
  about yet" property.
- **The shareable set is unchanged**: `area`, `goal`, `project`, `review`,
  `board`, `task`. Not `thought`. `document` is still absent, and a shared document
  shelf is an explicit extension to §13's list with its own redaction and cascade
  rules, not something a group grant quietly implies.
- **Shared-in material stays out of the recipient's AI**: zero rows in the grantee
  group's `ResparkableEmbedding`, asserted by query inspection rather than by
  mocking (test 13f). A pooled, jointly-queryable corpus is a legitimate ask and a
  **different feature**, because it needs the embedding path to become
  multi-space, which is a new isolation plane rather than a phase.
- The share dialog names the grantee group **and its current member count**, and
  the snapshot option becomes the recommended default for a cross-group share
  rather than merely the safer one. The dynamic-filter trap is worse when the
  grantee's roll is itself a moving target.
- `/shared-with-me` becomes per space. Resist unifying it with
  `/resparkable/sharing`: one reads other people's rows through a grant, the other
  reads the space's own rows and the grants it issued. `sharing.md` warns against
  it, and a group inventory will feel like a third thing.

Tests 13f and 13g. §13's tests 3 and 4 must still pass **unchanged** with a
personal grantor and grantee.

### Phase 50: the digest, and the budget that refuses before it spends

**The digest** reuses two things rather than adding a reporting layer:
`ResparkableEvent` (already written on every meaningful mutation, already
space-scoped) and `ResparkableReview` (already the persisted-artefact table with a
`horizon` discriminator). A group digest is
`ResparkableReview{horizon: 'group_digest'}` produced by a workflow on the group's
schedule, deterministic gather first and one LLM call at the end, in the same
shape as the morning briefing (§6) and the context digest (phase 42).

Registered as a **gated kind** on phase 56's queue: append to
`RESPARKABLE_JOB_KINDS`, add a `RESPARKABLE_JOB_SPECS` entry with
`demandGated: true, spendsCredits: true`, and add a `case` to `runResparkableJob`
(the `const unhandled: never = kind` forces it). A `group_digest` over a window
whose only `ResparkableEvent` rows are `source: 'system'` **does not run at all**.
A group of thirty that had a quiet fortnight is a common case, and the group's
balance is somebody's actual money.

Per-group scheduled work is **cheaper** than per-user: a group of thirty produces
one digest run, not thirty. It does not exempt the digest from D7. It drains a
queue until empty, and `GROUP_DIGEST_BATCH = 50` is exactly the constant D7 exists
to forbid.

**It never ranks members against each other and never frames a person as behind.**
No per-member counts, no leaderboards, no "most active", no "X has not contributed
since". Asserted in test 13h with the model stubbed to be maximally unhelpful,
which is what proves the constraint lives in the gather step and the agent's
guardrails rather than in the prompt's manners.

**The budget** (§23.12). Recording spend is nearly free once the account is
space-keyed; capping it is not:

- The group's balance is the **group's**, and an admin tops it up. Not a pool
  assembled from members' personal balances.
- A member spends the group's balance and **never falls back to their own**.
  `assertPositiveBalance` in `lib/framework/resparkable/services/billing.ts`
  resolves exactly one account, the space's, and an empty group balance is a
  refusal rather than a redirect.
- `ResparkableGroupMember.dailyCreditCap Float?`, with `null` meaning uncapped and
  being the default. This is **blast radius**, not a productivity control: it
  answers "a member left a workflow looping overnight", not "a member is using too
  much". Enforced in the same pre-flight `assertPositiveBalance` sits in, so it
  refuses **before** the provider call. Never debit for a run that cannot produce
  anything.
- A `viewer` spends **zero**, not a small cap.
- `ResparkableCreditLedgerEntry` gains `actorUserId` so an admin can see who spent
  what. **Members see the balance and see nothing about who spent it.** An admin
  sees spend; nobody sees productivity.
- Two admin-only notifications: the balance crossing a configurable low-water
  mark, and a single run costing more than a configurable share of what remains.

Tests 13h and 13k.

> **Forward note, not scope.** §24.4 (Release 10, phase 52) re-keys
> `ResparkableCreditAccount` from the space to the **owner**, with `spaceId` on the
> ledger entry. Phase 50 builds on the space-keyed account deliberately, since
> §23.9 says a group space gets its own account the moment the key generalises,
> but whoever does phase 52 should read §23.12 first: "a member never falls back to
> their own balance" is the rule an owner-keyed account could quietly break.

---

## Branch 4: `feature/resparkable-groups-collaboration` (phases 57, 58, 59)

Design doc `phase-57-plan.md` first.

### Phase 57: joining, which is not the same as being invited

An admin naming thirty addresses is the reason the feature does not get used. A
**join link takes §13's public-link discipline rather than the invite's**, and the
difference is worth stating in the UI and not only in a doc. An invite token
grants nothing on its own because the grant already names the address, so a
forwarded invite is useless without that mailbox. A join link names nobody, so **a
forwarded join link is the whole thing**.

- `randomBytes(24).toString('base64url')`, sha256 at rest, `tokenPrefix` for the
  UI. The same deviation from cuid for the same reason: cuids are
  timestamp-prefixed and monotonic. `mintToken` in `services/sharing.ts` and
  `hashShareToken` in `access/resolve.ts` are the existing implementations.
- `expiresAt` defaulting to 30 days, max 365, `null` only behind an explicit
  "never expires" checkbox; `revokedAt`; `maxUses` with a use count.
- **The role is fixed at mint time and can never be `admin`**, asserted at the mint
  route and not only in the UI. There is no join link that makes the holder an
  administrator of somebody's workspace. Default `member`, with `viewer` offered as
  the safer choice in the same words the share dialog uses for snapshots.
- **Approval.** A link is `open` (the link is the decision) or `request` (arriving
  creates a pending row an admin approves). `request` is the default for any link
  conferring more than `viewer`. A pending join is a `ResparkableGroupMember` row
  with `joinedAt: null` and a `requestedAt`, not a fourth table:
  `@@unique([groupId, userId])` already prevents a double request, approval is one
  `UPDATE`, and a rejection leaves nothing behind. **A pending member resolves to
  no scope at all**, so every read is a 404 and not a filtered list.
- `maxMembers`, defaulting to 50. A group at its cap refuses the join and tells
  the admin, rather than accepting it and dropping it.
- **Two new rate-limit tiers** in `lib/framework/resparkable/rate-limit.ts` beside
  `resparkable-invite`, both keyed on the acting user: link **minting**, because an
  unbounded set of live links is an unbounded set of credentials to one workspace,
  and link **redemption attempts**, because the token is a guessable-in-principle
  path parameter presented by a signed-in stranger. Both `DAY`-interval, like
  `resparkable-invite`.

**A public group directory is declined, not deferred.** A browsable list of groups
is a product with moderation, reporting and abuse obligations, none of which are
anywhere in this plan. Groups are reachable by invite or by link and by nothing
else.

Test 13i.

### Phase 58: working on one item together

Five things, four of them cheap.

- **Assignment.** `ResparkableTask.assignedToUserId String?`, FK to `"user"("id")`
  `ON DELETE SetNull` (so it needs drift coverage, like B8 and B9), indexed with
  `spaceId`. The assignee must be a current member, checked **where the scope is
  minted** and not inside a repo query. "Tasks assigned to me" is a filter and is
  fine; "tasks per member, with counts" is the leaderboard arriving through the
  board, and takes the same answer as §23.8's: **no aggregate over members renders
  anywhere in a group space**. In a personal space the field is null and renders
  nothing.
- **Comments on the `space` basis.** `ResparkableComment` already exists and today
  means "a grantee said something about an item shared with them". In a group it
  means something weaker and safer: every member can comment on every item, because
  they can already write the item itself. One table, one route, and the only
  difference is the basis `resolveResparkableAccess` returns. Editing is the
  author's alone; deleting is the author's or an **admin's**, since in a group space
  the admin role is what succeeds "the owner". What does **not** carry over from
  phase 13: a member's comment is in scope for the group's agent like everything
  else in the space (§23.9's already-accepted trade). The exclusion still holds,
  unchanged, for comments arriving through a grant **into** the group.
- **`rev` earns its second use.** `rev Int @default(0)` ships on seven models
  (`Area`, `Goal`, `Project`, `Task`, `Thought`, `Entity`, `Review`) and is
  currently dormant, added in phase 1 precisely so this would need no backfill. A
  write sends the `rev` it read, the `UPDATE` matches on it, and a mismatch returns
  **409 carrying the current row** rather than silently overwriting somebody
  mid-sentence. **No migration.** Rows without `rev` keep last-write-wins, which is
  right for a tag or a card position and must be a _listed_ decision: the coverage
  list is asserted by enumeration, so a model added later is either in the list or
  fails the test.
- **Leaving voluntarily**, distinct from erasure, which is about accounts ending
  rather than relationships. The membership row goes; `createdByUserId` values
  **stay**, because the content is the group's; assignments clear to null rather
  than silently moving to somebody who did not agree to them; comments stay; and
  access ends at the **next request**, not the next session. Before leaving, a
  member may export what they contributed, and that set needs no new definition:
  phase 48's Art. 15 predicate is exactly it. Two definitions of "what I
  contributed" would drift, and one of them is the one a regulator reads. The last
  admin cannot leave.
- **`ResparkableGroupAuditEntry`.** Role changes, removals, join approvals, link
  minting and revocation, and budget changes are actions one person takes that land
  on another. They do not belong in `ResparkableEvent`, which records what happened
  to the brain's **content**, and they do not belong in `AiAdminAuditLog`, because a
  group admin is not a deployment operator. So: its own table, hanging off the
  group, append-only, admin-visible, outside the D1 cascade with the other two group
  tables. **This is the one surface in the release where naming a member next to an
  action is correct**, and the reason is worth keeping straight: §23.8's rule
  protects people from having their work counted, it has never protected an
  administrator from a record of administering, and the subject of an administrative
  action has a right to see it.

**Three notification emails and no more** (§23.13): the group was deleted, your
membership or role changed, and phase 50's admin-only budget thresholds. Everything
else, the feed and the digest included, is in-app. Templates go in
`components/resparkable/emails/` beside `share-invite.tsx`, **not** in Sunrise-owned
`emails/`, and are not registered as an `EmailKind` (the registry exists so a fork
can override a _platform_ email, and nothing outside this tier sends these). An
email per activity is precisely how a group workspace becomes a thing people mute,
after which the three that mattered are muted too.

**Per-space storage quota**, and upload restricted to `member` and above, because a
viewer uploading a book is a write. The shared shelf is a real ingestion: parse,
chunk and embed several hundred pages, charged to the group's balance, with the
original retained under `framework-resparkable/<spaceId>/`. Neither limit is new
machinery. Both are numbers that currently have no owner.

Test 13j.

### Phase 59: the activity feed, and the four things it is not

One source, two cadences. The feed answers _what happened_ and costs nothing; phase
50's digest answers _what it means_ and is the only half worth a model call.

**The source already exists and nothing new is captured.** `ResparkableEvent` is
written on every meaningful mutation, is already space-scoped, already carries
`kind`, `entityType`, `entityId` and `metadata`, and its
`@@index([userId, createdAt(sort: Desc)])` becomes `[spaceId, createdAt desc]` at
phase 45, which is exactly the index a feed reads. **No new index** (test 13l).

**On an event row, `createdByUserId` is the actor, not the item's author.** A task
Sam created and Priya completed produces one row attributed to Sam and one to
Priya, and a feed that read the task's author for both would put Sam's name on
Priya's work. Say this in the column comment on `ResparkableEvent` specifically,
because the name invites the wrong reading.

**`source: 'system'` means the group did it, not that nobody did.** The column
already exists and already drives phase 56's demand gate. Render it as the
workspace acting ("Nightly triage promoted 3 thoughts"), never as an unattributed
line that reads like somebody hiding.

Four things it is not:

1. **Not the Activity pane.** `components/resparkable/activity/activity-pane.tsx`
   is a decision queue: connections the sweep proposed, accept or reject. An event
   feed is a record and has no decision in it. Putting the second inside the first
   gives one surface two jobs and the queue wins, because a queue with unread items
   is louder than a log. The feed is its **own Workspace tab**, which per `ui.md`
   step 6 means a `tab-registry.ts` entry **and** a `change-scope.ts` one, or the
   coverage tests fail.
2. **Not push.** Poll, with conditional requests. A thirty-member group with
   everyone's laptop open is thirty held SSE connections to produce a line every few
   minutes: the query is cheap and the connection is the cost. So: a `GET` using
   `computeETag` and `checkConditional` from `lib/api/etag.ts` (nine resparkable
   routes already do), polled only while the tab is focused and the pane visible,
   and stopped entirely when the document is hidden. **There is no polling anywhere
   in the tier today.** `setInterval` appears nowhere in `components/resparkable` or
   `lib/framework/resparkable`, so the visibility-gated poll hook is genuinely new
   code and should be written once and shared.
3. **Not a per-row ACL, and neither is the read watermark.** Every member sees
   every event in the space. What is per member is one `feedSeenAt` column on
   `ResparkableGroupMember`, a table that already holds exactly one row per member
   per group. It is not a filter in `repo/**`, it does not reach `SpaceScope`, and no
   query's `WHERE` gains a term. Asserted by comparing the emitted SQL for a member
   who has read everything against one who has read nothing.
4. **Not a monitor, and this is the hard one.** A feed is by construction a list of
   names next to actions ordered by recency, which is what a productivity monitor
   looks like, and it would arrive without anyone deciding to build one. Three
   rules, asserted in tests:
   - **The subject of a line is the item; the person is attribution.** "Chapter 4
     notes, added by Sam" rather than a column of Sams.
   - **No count over members, anywhere, ever.** No per-member totals, no "12 this
     week", no sort by member, no "most active", no streak. `ResparkableEvent` has
     no index on the actor and does not get one, which makes the aggregate awkward
     as well as forbidden.
   - **Filtering by member is allowed; counting the filter is not.** "What did Priya
     write about chapter 4" is a legitimate content question. A filtered list is a
     search result; the same list with "31 items" over it is a performance review.

**An unknown event kind renders as nothing.** `kind` is a `VarChar(24)` with an
enumerated set in its schema comment, and a kind added in a later release must not
put a raw discriminator in front of thirty people. Map kinds to sentences and drop
what you cannot render: the failure direction that costs a missing line rather than
a leaked internal.

Tests 13l and 13m. 13m is deliberately a **rendering** test rather than a data
test, because the rows are all there and always were, and the whole rule is about
what is built on top of them.

---

## Verification

Per branch, in order. `npm run lint` and `npm run validate` need
`--max-old-space-size=12288` or they OOM.

**Every branch**

```bash
npm run validate                 # CHANGELOG + node + type-check + lint + format
npm run test
npm run db:migrate:dev           # then inspect the generated SQL by hand
npm run db:drift-check           # non-negotiable after EVERY migrate dev
npm run framework:resparkable:smoke-isolation   # 27 assertions, real DB
npm run framework:resparkable:smoke-search      # 26 assertions, real DB
```

Then `/pre-pr`, `/security-review` and `/code-review`, or `/pr-gates`, which runs
all three and loops until clean.

**Branch 1 (phase 45)** additionally needs the lossless proof: row counts and a
content checksum per satellite table captured before the migration and compared
after, plus a re-run of the untouched test suite. See the phase 45 section for the
script.

**Branch 2** extends `npm run framework:resparkable:smoke-isolation` with the group
cases: a member of group A cannot mint a scope for group B's space, a `viewer`
cannot reach any write path, and a removed member 404s on the next request. The
erase-a-member case runs against a real DB, mirroring `scripts/smoke/erasure.ts`.
Capture-defaults-to-personal is asserted **per path**, all six.

**Branch 3** keeps `npm run framework:resparkable:eval-triage` green, since the
digest agent shares the `resparkable-core` profile's guardrails. Test 13k is proved
by **counting provider calls**, not by inspecting configuration: an empty group
balance must refuse without a provider call and must never debit the actor's
personal balance.

**Branch 4** gets checked by hand at `https://resparkable.test/resparkable` (not
`localhost:3016`; run `cd ~/code/dev-proxy && ./apply.sh` if the cert errors). Two
browser profiles in one group, act in one, watch the other's feed return 304 until
it doesn't. DevTools Network confirms the poll stops when the tab is hidden.

**Docs to update as each branch lands**: `plan.md`'s Release 9 table (mark the
phase **DONE** with a date, as Releases 1.5 and 2 do), the tier `README.md` status
block and its inventory counts, `sharing.md` for phase 49, `ui.md` for phases 47
and 59, and `CHANGELOG.md`'s `## [Unreleased]`.

---

## Two things in the spec that the code has since moved past

Flagged for the implementer rather than fixed here. Both are `plan.md` edits to
make in the phase 45 design doc, not decisions to take.

1. **§23.2 says "21 satellite tables"; there are 23.** `ResparkableComment`,
   `ResparkableShareLink` and `ResparkableJob` arrived after the count was written.
   `ResparkableSettings` and `ResparkableBillingSettings` are operator singletons
   and carry no owner key. The migration must be built from a generated inventory of
   `space ResparkableSpace @relation(...)` in the schema, not from the number in the
   prose.
2. **`sharing.md`'s basis table answers "who may write a comment" and never answers
   "who may read the thread".** Its `Comments` column tracks
   `permissions.comment`, correctly: a cascaded item cannot be commented on even
   with a commenter grant on its parent. But `redactionsFor()` in
   `access/resolve.ts` opens the `comments` **field** for `grant` and
   `grant-cascade` alike, so a cascaded grantee _reads_ a thread the table shows as
   ❌. Both behaviours are right; the table is one column short. Phase 58 has to
   answer "who can see the discussion" out loud in a group UI, so add the read
   column to `sharing.md` in branch 3 or 4 rather than inferring it.
