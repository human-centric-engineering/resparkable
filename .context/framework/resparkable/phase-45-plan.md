# Phase 45: the space key

**Release 9, phase 45. Scoped 2026-08-29.** The specification is
[`plan.md`](./plan.md) §23.2, §24.1 and §24.2; the release sequencing is
[`release-9-plan.md`](./release-9-plan.md). This document records what phase 45
decides, what it deliberately does not do, and the four places where the
specification was written against a schema that has since moved.

Phase 45 **ships behind no flag and changes no behaviour.** It renames the tier's
owner key from `userId` to `spaceId` across `ResparkableSpace` and its 23
satellites, moves the GDPR cascade FK onto a new nullable `ownerUserId`, and lands
Release 10's workspace columns in the same migration so the tier's largest tables
are migrated once, ever. Nothing about groups is reachable until phase 46.

## What the specification got wrong, and what this phase does instead

Four corrections, each verified against the code rather than reasoned about.

### 1. It is 23 satellites, not 21

§23.2 says 21. `ResparkableComment`, `ResparkableShareLink` and `ResparkableJob`
arrived after that count was written, and `ResparkableSettings` /
`ResparkableBillingSettings` are operator singletons carrying no owner key at all.
The migration is generated from the schema rather than transcribed from the prose:
24 models carry the key, being the parent plus 23 satellites.

### 2. "Zero rows rewritten" cannot include the parent

`framework_resparkable_space` gains six columns and a backfill, so the invariant is
stated as **zero writes to the 23 satellites, exactly one write per existing space
row on the parent**. Stated the other way it is unassertable.

The backfill also sets **`isDefault = true`**, which §23.2 omits. Without it every
existing user ends up with no default workspace, and §24.2 is explicit that a user
may not have none.

### 3. `ResparkableJob` cannot relate to `ownerUserId`

The model's own docblock said that after phase 45 "it relates to `ownerUserId`".
It cannot: `ownerUserId` is deliberately non-unique (that absence is what makes
several workspaces per owner possible without a second pass over 21 tables) and a
Postgres foreign key requires a unique target. Phase 45 renames `job.userId` to
`spaceId` mechanically with the other 22 and leaves the FK on
`ResparkableSpace.spaceId`. Re-keying the queue to the owner is phase 51 (W2)
work, where §24's row-count invariant actually needs it. The docblock is corrected
in this phase rather than left to mislead the next reader.

### 4. `owner` is the wrong invariant to assert on a personal space

§23.2 says a `SpaceScope` for a `kind: 'personal'` space is always `owner`. It is
not: `sharedOwnerScope` and `grantOwnerScope` in
[`access/resolve.ts`](../../../lib/framework/resparkable/access/resolve.ts) mint
scopes on **someone else's** personal space for a grantee, and those are `viewer`.
The invariant this phase asserts is the exclusion §23.2 actually wants:

> `owner` never appears on a `kind: 'group'` space, and a non-`owner` role on a
> personal space arises only from `access/**`.

Relatedly, `actorUserId` is `string | null`, not `string`.
`ResparkableViewer.userId` is nullable because an anonymous public-link reader has
no account. The null can never reach a `WHERE`, because `actorUserId` is never a
filter.

## The decision that shapes the branch: a transitional `@map`

The migration is irreversible and the type rename is churny, and mixing them puts a
thousand-line diff in front of the reviewer at the exact moment they most need to
read forty lines of SQL carefully. So they are separated, using a Prisma field
mapping as the hinge:

|                    | DB column     | Prisma field             |
| ------------------ | ------------- | ------------------------ |
| Before             | `userId`      | `userId`                 |
| **After commit 2** | **`spaceId`** | `userId @map("spaceId")` |
| After commit 6     | `spaceId`     | `spaceId`                |

Commit 2 therefore carries the whole SQL file and **zero TypeScript and zero test
changes**, so the entire existing suite runs as an unmodified control over the
migrated database. That is the evidence §16's test 13a is reaching for, and it is
only available if the field rename is a separate commit. Commit 6 carries no
migration at all, so every failure in it is a real code bug.

A permanent `@map` in either direction is rejected. Raw SQL, `psql`, `EXPLAIN`,
the drift probes and every index name would disagree with the code, which is the
drift-by-naming this tier writes paragraphs to prevent, and §24 makes it actively
wrong: there, `spaceId` and `ownerUserId` genuinely diverge and a column called
`userId` means neither.

**The staging depends on Prisma deriving default index and constraint names from
the mapped column rather than the field, and that was verified before anything was
written**: mapping one model's field to a differently-named column produced a
`prisma migrate diff` identical to the baseline, statement for statement.

## Object names are harvested from Prisma, never derived by hand

Renaming a column does not rename the indexes and constraints named after it.
Leaving them is not cosmetic: Prisma concludes the object is misnamed and injects a
phantom `ALTER INDEX … RENAME TO` into **every future migration**, including ones
touching unrelated tables, which the next person scrubs incorrectly. The same
failure is already documented for `ai_conversation_inbound_key` in
[`prisma-7-baseline-bugs.md`](../../database/prisma-7-baseline-bugs.md).

**78 objects are renamed here: 55 indexes and 23 foreign keys.** They were paired
structurally, by `(kind, table, column-list)`, between a `--from-empty` render of
the current schema and one of the renamed schema, rather than by string
substitution on the names. That matters for four of them, where several names are
already at Postgres's 63-character limit and adding a character to `userId` shifts
the truncation point somewhere a hand-derivation would not put it:

```
framework_resparkable_link_userId_sourceType_sourceId_targe_key
   ->  framework_resparkable_link_spaceId_sourceType_sourceId_targ_key
framework_resparkable_embedding_userId_entityType_entityId__key
   ->  framework_resparkable_embedding_spaceId_entityType_entityId_key
framework_resparkable_share_link_userId_entityType_entityId_idx
   ->  framework_resparkable_share_link_spaceId_entityType_entityI_idx
framework_resparkable_comment_userId_entityType_entityId_create
   ->  framework_resparkable_comment_spaceId_entityType_entityId_c_idx
```

The last of those also closes a **pre-existing** mismatch: the deployed name is
`…_entityId_create` while Prisma wants `…_entityId_cr_idx`, so that rename has been
sitting in every `migrate diff` on `main`. The sibling
`framework_resparkable_grant_entityType_entityId_granteeEmail_ke` carries no
`userId` and is unrelated to this phase, but it is fixed in the same migration for
the same reason: while either one stands, `migrate diff` cannot be used as a gate,
because real drift hides in known noise.

## The migration

`ALTER TABLE … RENAME COLUMN` updates `pg_attribute.attname` and nothing else. It
does not touch `attnum`, so every index and constraint keeps working (they
reference columns by number), and no heap or index page is rewritten. The two
`GENERATED` tsvector columns are outside the blast radius entirely:
`task.searchVector` derives from `title || notes` and `embedding.searchVector` from
`content`, and neither reads the owner key. `ADD COLUMN … NOT NULL DEFAULT
<constant>` is metadata-only on PG 11 and later, which the migration asserts rather
than assumes.

Statement order, and why:

1. Drop the old B1 FK. It is being **moved** to another column, and a constraint
   cannot be moved by rename.
2. Rename the parent's key. Every satellite FK follows automatically.
3. Rename the column on all 23 satellites.
4. Rename the 55 indexes, then the 23 satellite FK constraints. Catalog-only, no
   revalidation scan. All the `_key` objects here are plain unique **indexes**
   rather than unique **constraints**, so `ALTER INDEX … RENAME TO` is correct and
   there is no `pg_constraint` row to chase.
5. Add the six space columns and `createdByUserId` on the satellites.
6. The one backfill: `ownerUserId = "spaceId"`, `kind = 'personal'`,
   `isDefault = true`.
7. Re-add B1 on `ownerUserId`, **after** the backfill or validation fails. It
   cannot fail on real data, because the FK dropped in step 1 already guaranteed
   every key value is a live user id.
8. The plain index on `ownerUserId`, then B10, the partial unique.
9. The schedule scope key, written **additively**.

Prisma wraps a migration in a transaction on Postgres, so this is all-or-nothing,
and it is also why the partial unique is a plain `CREATE UNIQUE INDEX` rather than
`CONCURRENTLY`. It is one row per user; the cost is nothing.

### The schedule scope key is added, not replaced

§24.2 says `RESPARKABLE_SCHEDULE_OWNER_KEY` becomes `resparkableSpaceId`. This
phase **writes both keys and reads either**, because migrations run at deploy,
before the new code is on every pod. A destructive rewrite opens a window in which
an old reader finds nothing and silently resolves no owner: a skipped bill, or a
04:30 briefing in which every capability throws with nothing surfacing it. That is
the exact failure
`20260805120000_resparkable_schedule_owner_scope` was written about. Keeping both
makes "a pre-migration row still resolves" trivially true and leaves a one-line
deletion for a later phase.

All three `jsonb` scope columns are updated: `ai_workflow_schedule`,
`ai_workflow_execution` and `ai_workflow_trigger`.

## `createdByUserId` lands here, which §15 does not say

§15's phase-45 row does not list §23.5's `createdByUserId`. It is taken here
deliberately, on phase 45's own argument: it is 23 more nullable columns on the
same 23 tables, and the whole point of this phase is that the tier's largest tables
are migrated once, ever. Discovering it in phase 48 would mean a second pass over
every table in the brain to add a column that was always going to be needed.

`ON DELETE SetNull`, never `Cascade`. When a member is erased their _authorship_
disappears and the group's content stays, because that content is the group's. Note
the asymmetry with `ResparkableComment.authorUserId`, which genuinely cascades
(probe B9): **authored rows in a group space survive an erasure and comment bodies
do not.** One is the group's record and the other is a person's words.

These are 23 more foreign keys Prisma cannot model, because Resparkable must not add
a relation field to the Sunrise-owned `User`. They get **one parameterised probe
over the table list** rather than 23 probes: B1, B8 and B9's per-object shape does
not scale to a whole tier.

On `ResparkableEvent` the column means something different from everywhere else and
the schema comment says so, because the name invites the wrong reading: **on an
event row it is the actor**, not the item's author. A task Sam created and Priya
completed produces one row attributed to Sam and one attributed to Priya.

## Probes

- **B1 rewritten** to assert the FK by _definition_ on `ownerUserId`, not by mere
  existence, keeping the `ON DELETE CASCADE` assertion it already made. Paired with
  a forbidden probe that the old `framework_resparkable_space_userId_fkey` is gone,
  which is what catches a half-applied migration.
- **B10, new**: the partial unique index enforcing at most one live default
  workspace per owner. Asserted by `pg_indexes.indexdef` containing
  `CREATE UNIQUE INDEX`, the column, and the predicate. Mere existence would pass on
  a plain non-unique non-partial index of the same name, which is the identical
  silent failure `generatedColumnExists` was written to close.
  `idx_ai_knowledge_base_single_default` (probe A7) is the precedent.
- **B11, new**: the parameterised `createdByUserId` probe over all 23 satellites.

`ownerUserId` is nullable and NULLs never collide in a unique index, so group spaces
are unconstrained by B10 by design. Phase 46 adds the `groupId` sibling.

## What this phase does not do

- **No group tables.** `ResparkableGroup` and `ResparkableGroupMember` are phase 46.
  `kind` accepts `'group'` and nothing creates one.
- **No second workspace.** The columns and the constraint that permit multiplicity
  all land here; the product surface that creates one is Release 10.
- **No role checks.** `SpaceScope.role` exists and nothing branches on it. It is
  asserted inert: no function in `repo/**` may put `actorUserId` in a `where`, and
  the existing structural sweep in `repo/isolation.test.ts` is extended to prove it
  rather than a comment claiming it.
