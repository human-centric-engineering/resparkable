/**
 * Resparkable drift probes: the Postgres objects Prisma cannot model.
 *
 * **This is the highest-value regression guard in the build** (plan §2, §17
 * risk 1). `prisma migrate dev` computes desired state from the schema and
 * emits `DROP` for anything it can't represent, so every future migration
 * arrives pre-loaded with statements that would delete these. The drops are
 * silent: a dropped HNSW index doesn't error, it just turns vector search into
 * a sequential scan whose only symptom is latency that grows with the corpus.
 * Exactly that happened to Resparkable's own `idx_knowledge_embedding` upstream and
 * went unnoticed for seven weeks.
 *
 * A host project registers these in one line from `lib/app/db-drift.ts`; then
 * `npm run db:drift-check` (run in CI and by `/pre-pr`) fails the moment one
 * goes missing. Run it after EVERY `migrate dev`. Non-negotiable.
 *
 * Source of truth: the Group B block at the foot of
 * `prisma/migrations/20260728222816_add_second_brain/migration.sql`, plus the
 * later migrations that added to it. The count has been wrong in three places
 * since sharing landed (the schema header still said "six" while this file
 * registered nine), so it is deliberately not restated as a number here: the
 * list below is the inventory, and `.context/database/prisma-unmodelled-objects.md`
 * is the cross-tier one.
 *
 * Phase 45 (§23.2) moved B1 onto `ownerUserId` and added B10 and B11. B11 covers
 * 23 hand-written foreign keys with a single parameterised probe rather than 23
 * near-identical registrations: at a whole tier's worth of columns the
 * one-probe-per-object shape B1, B8 and B9 use stops being readable.
 *
 * Phase 46 (§23.3) added B13, the group tables' three keys into `User`, on the
 * same parameterised shape. Note what B13 and B12 do together: B12 keeps a group
 * space OUT of the erasure cascade, and B13 keeps a membership IN it. Erasing a
 * member removes their memberships and leaves the shared workspace standing,
 * which is §23.6's whole requirement, and neither half is visible in the Prisma
 * schema.
 */

import { prisma } from '@/lib/db/client';
import {
  registerAppDriftProbe,
  constraintExists,
  generatedColumnExists,
  indexExists,
  type Probe,
} from '@/lib/db/drift-probes';

/**
 * Invert an existence probe into a **forbidden-object** probe.
 *
 * Two of these probes changed sides on 2026-08-25 (scale.md S3): the HNSW and
 * GIN indexes on `framework_resparkable_embedding` were dropped because no query
 * can use them, and the thing that now needs guarding is that nobody puts them
 * back. That is not a hypothetical: `prisma migrate dev` computes desired state
 * from the schema, cannot represent either index, and a well-meaning
 * "restore the missing index" migration is exactly what a reviewer would wave
 * through.
 *
 * A forbidden-object probe is worth as much as an existence one here, because
 * both failures are silent. A missing index that should exist costs latency; an
 * index that should not exist costs roughly the size of the largest table in the
 * database plus a graph traversal on every insert, and nothing anywhere errors.
 *
 * `note` carries the reason, so the check output explains itself rather than
 * saying only that an index it has never heard of is present.
 */
function absent(probe: Probe, why: string): Probe {
  return async () => {
    const result = await probe();
    return result.ok ? { ok: false, note: why } : { ok: true };
  };
}

/**
 * Assert a column's underlying Postgres type by name.
 *
 * Core has `columnExists` and `generatedColumnExists`; neither can say what
 * *type* a column is, and for a pgvector column that is the only thing worth
 * asserting. `framework_resparkable_embedding.embedding` is
 * `halfvec(1536)` — a type Prisma models as `Unsupported`, which means
 * `prisma migrate dev` cannot represent it and will emit something wrong for it
 * given the chance. `columnExists` would report green the whole time, because a
 * column of that name would still be there.
 *
 * `information_schema.columns.data_type` reads `USER-DEFINED` for every
 * extension type, so it distinguishes nothing. `udt_name` is the actual type
 * name (`halfvec`, `vector`, `tsvector`) and is standard enough to rely on.
 *
 * Pinned to `current_schema()`. Without it a database carrying the same table
 * name in a second visible schema answers from whichever row comes back first,
 * and an unordered single-row read is a probe that reports on the wrong object
 * — green or red, both meaningless.
 *
 * Local rather than upstream because it is one query and this is the only
 * caller; if a second fork needs it, it belongs in `lib/db/drift-probes.ts`
 * next to its three siblings and is worth an ask.
 */
function columnHasType(tableName: string, columnName: string, udtName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ udt_name: string | null }>>`
      SELECT udt_name
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
        AND table_schema = current_schema()
    `;
    const actual = rows[0]?.udt_name;
    if (!actual)
      return { ok: false, note: `column ${tableName}.${columnName} is missing entirely` };
    if (actual !== udtName) {
      return { ok: false, note: `expected ${udtName}, found ${actual}` };
    }
    return { ok: true };
  };
}

/**
 * Assert a constraint's definition contains ALL of several substrings.
 *
 * Core's `constraintExists` takes one substring, which is enough for a CHECK
 * predicate and not enough for a hand-written foreign key: a key has both a
 * column and an `ON DELETE` action, and each is silently catastrophic on its
 * own. B1 named `framework_resparkable_space_userId_fkey` before phase 45 and
 * names `..._ownerUserId_fkey` after it, but a name is not a definition, and a
 * constraint of the right name on the wrong column is exactly what a
 * regenerated migration produces.
 *
 * Local for the reason `columnHasType` is: one query, one caller. If a second
 * fork needs it, it belongs beside its siblings in `lib/db/drift-probes.ts`.
 */
function constraintDefMatches(constraintName: string, ...required: string[]): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string | null }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = ${constraintName}
    `;
    const def = rows[0]?.def;
    if (!def) return { ok: false, note: `constraint ${constraintName} is missing entirely` };
    const missing = required.filter((needle) => !def.includes(needle));
    if (missing.length > 0) {
      return { ok: false, note: `definition missing ${missing.join(' and ')} — saw: ${def}` };
    }
    return { ok: true };
  };
}

/**
 * Assert an index's DEFINITION rather than merely its name.
 *
 * `indexExists` passes on any index of that name, and the object B10 guards is a
 * **partial unique** index. A plain non-unique non-partial index called the same
 * thing satisfies existence and enforces nothing, which is the identical silent
 * failure `generatedColumnExists` was written to close one layer down: the
 * object is present, nothing errors, and the invariant it was there to hold (at
 * most one live default workspace per owner) quietly stops holding.
 *
 * Postgres normalises predicate text when it stores an index, so the expected
 * strings here were read back off a real database rather than guessed from the
 * migration's source: `WHERE "isDefault" AND "archivedAt" IS NULL` comes back as
 * `WHERE ("isDefault" AND ("archivedAt" IS NULL))`.
 */
function indexDefMatches(indexName: string, ...required: string[]): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string | null }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE indexname = ${indexName}
        AND schemaname = current_schema()
    `;
    const def = rows[0]?.indexdef;
    if (!def) return { ok: false, note: `index ${indexName} is missing entirely` };
    const missing = required.filter((needle) => !def.includes(needle));
    if (missing.length > 0) {
      return { ok: false, note: `definition missing ${missing.join(' and ')} — saw: ${def}` };
    }
    return { ok: true };
  };
}

/**
 * Every satellite carrying §23.5's `createdByUserId`, and therefore a
 * hand-written `ON DELETE SET NULL` foreign key to `"user"`.
 *
 * Written out rather than discovered from `information_schema`, because a probe
 * that derives its own expectations from the database cannot fail: if phase 46
 * adds a table and forgets the key, a derived list simply would not look for it.
 * A table added later is either in this list or is not covered, and the list is
 * the thing a reviewer reads.
 */
export const CREATED_BY_TABLES = [
  'framework_resparkable_area',
  'framework_resparkable_board',
  'framework_resparkable_board_card',
  'framework_resparkable_checklist_item',
  'framework_resparkable_comment',
  'framework_resparkable_credit_account',
  'framework_resparkable_credit_ledger_entry',
  'framework_resparkable_document',
  'framework_resparkable_embedding',
  'framework_resparkable_entity',
  'framework_resparkable_event',
  'framework_resparkable_goal',
  'framework_resparkable_grant',
  'framework_resparkable_job',
  'framework_resparkable_link',
  'framework_resparkable_project',
  'framework_resparkable_review',
  'framework_resparkable_share_link',
  'framework_resparkable_tag',
  'framework_resparkable_task',
  'framework_resparkable_task_tag',
  'framework_resparkable_thought',
  'framework_resparkable_time_block',
] as const;

/**
 * B11 in one query: every `createdByUserId` key exists and every one is SetNull.
 *
 * The action is the whole point, not a detail. `SetNull` is what makes an
 * erasure remove a member's authorship and leave the group's content, because
 * that content is the group's (§23.5). Recreated as `Cascade` — which is what a
 * regenerated migration would reach for, since it is the action every other key
 * in this tier uses — one departing member silently deletes a term's worth of
 * shared material, and nothing anywhere errors.
 *
 * Reports the offenders by name. "One of 23 is wrong" is not an actionable
 * failure message at 3am.
 */
const createdByKeysAreSetNull: Probe = async () => {
  const rows = await prisma.$queryRaw<Array<{ table_name: string; def: string }>>`
    SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND c.contype = 'f'
       AND c.conname LIKE 'framework_resparkable_%_createdByUserId_fkey'
  `;
  const byTable = new Map(rows.map((row) => [row.table_name, row.def]));

  const missing = CREATED_BY_TABLES.filter((table) => !byTable.has(table));
  const wrongAction = CREATED_BY_TABLES.filter(
    (table) => byTable.has(table) && !byTable.get(table)?.includes('ON DELETE SET NULL')
  );

  if (missing.length > 0 || wrongAction.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing on ${missing.join(', ')}`);
    if (wrongAction.length > 0) parts.push(`not ON DELETE SET NULL on ${wrongAction.join(', ')}`);
    return { ok: false, note: parts.join('; ') };
  }
  return { ok: true };
};

/**
 * B13's inventory: the three hand-written `User` keys the group tables carry.
 *
 * Parameterised like B11 rather than registered three times, for B11's stated
 * reason: the check output has to stay readable, and three near-identical lines
 * is already the shape a human stops reading.
 *
 * **The actions differ, and the difference is the design** (§23.3, §23.5). A
 * member's row IS their membership, so erasing them removes it: losing your
 * account removes your memberships, not the groups. An inviter's name on
 * somebody else's invitation is attribution, so it nulls out and the invitation
 * stands, because an inviter closing their account must not silently withdraw an
 * invitation the invitee is about to accept.
 *
 * Getting either backwards is silent. `SetNull` on the membership leaves rows
 * granting access to a user id that no longer resolves; `Cascade` on an
 * inviter's column deletes other people's memberships and invitations when one
 * person leaves, which is a data-loss complaint with no recovery path.
 */
const GROUP_USER_KEYS = [
  {
    table: 'framework_resparkable_group_member',
    constraint: 'framework_resparkable_group_member_userId_fkey',
    action: 'ON DELETE CASCADE',
  },
  {
    table: 'framework_resparkable_group_member',
    constraint: 'framework_resparkable_group_member_invitedByUserId_fkey',
    action: 'ON DELETE SET NULL',
  },
  {
    table: 'framework_resparkable_group_invite',
    constraint: 'framework_resparkable_group_invite_invitedByUserId_fkey',
    action: 'ON DELETE SET NULL',
  },
] as const;

/** B13 in one query: all three keys exist, each with the action it needs. */
const groupUserKeysHaveTheirActions: Probe = async () => {
  const rows = await prisma.$queryRaw<Array<{ conname: string; def: string }>>`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND c.contype = 'f'
       AND t.relname IN ('framework_resparkable_group_member', 'framework_resparkable_group_invite')
  `;
  const byName = new Map(rows.map((row) => [row.conname, row.def]));

  const missing = GROUP_USER_KEYS.filter((key) => !byName.has(key.constraint));
  const wrongAction = GROUP_USER_KEYS.filter(
    (key) => byName.has(key.constraint) && !byName.get(key.constraint)?.includes(key.action)
  );

  if (missing.length > 0 || wrongAction.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.map((k) => k.constraint).join(', ')}`);
    if (wrongAction.length > 0) {
      parts.push(
        `wrong action: ${wrongAction.map((k) => `${k.constraint} is not ${k.action}`).join('; ')}`
      );
    }
    return { ok: false, note: parts.join('; ') };
  }
  return { ok: true };
};

/**
 * `generatedColumnExists` was a local copy here until Resparkable shipped it in
 * response to ask #10 (resparkable#481) — core's own A1 probe had the same blind
 * spot the copy was written to close, and now uses this too.
 *
 * Why it matters, kept here because the import no longer says it: `columnExists`
 * passes on a plain `tsvector` column, which is the shape a careless migration
 * leaves behind. The column is still there, nothing errors, and it silently
 * stops being populated — so search quietly returns nothing for every row
 * written afterwards while old rows still match. Checking `is_generated` is what
 * makes the probe worth having.
 */

/**
 * Register Resparkable's nine probes. Seven assert an object EXISTS (B1, B2,
 * B4, B5, B6, B8, B9); B3 and B7 assert one does NOT (see `absent`). Idempotent per
 * process is NOT guaranteed —
 * `registerAppDriftProbe` throws on a duplicate name, which is deliberate: a
 * double registration means the host wired this up twice and should know.
 */
export function registerResparkableDriftProbes(): void {
  // B1 — the GDPR cascade, moved to `ownerUserId` by phase 45 (§23.2).
  //
  // Asserts the COLUMN and the ON DELETE action, not just existence. Both halves
  // are silently catastrophic on their own: recreated as ON DELETE RESTRICT it
  // breaks user erasure while every test still passes, and erasure failures
  // surface as a regulatory problem rather than a stack trace; recreated on the
  // old column it would put the cascade back on the space key, at which point
  // deleting one member's account takes a whole group's workspace with it.
  //
  // The second is the one phase 45 introduced and the reason the probe now
  // matches on the definition rather than the name. A group space is safe
  // BECAUSE it has `ownerUserId` NULL and is therefore unreachable from `user`;
  // that safety is invisible in the schema and lives entirely here.
  registerAppDriftProbe({
    name: 'B1 framework_resparkable_space_ownerUserId_fkey (hand-written FK → user, GDPR cascade)',
    kind: 'FK constraint',
    table: 'framework_resparkable_space',
    probe: constraintDefMatches(
      'framework_resparkable_space_ownerUserId_fkey',
      'FOREIGN KEY ("ownerUserId")',
      'ON DELETE CASCADE'
    ),
  });

  // B1b — the old key must be GONE.
  //
  // A half-applied phase-45 migration leaves both, and both is worse than
  // either: the cascade fires from two columns, so a group space that later
  // acquires an `ownerUserId` through some convenience is destroyed by an
  // unrelated account closure. Cheap to assert, and it is the only thing that
  // distinguishes "the migration ran" from "the migration ran to completion".
  registerAppDriftProbe({
    name: 'B1b framework_resparkable_space_userId_fkey (MUST NOT EXIST — superseded by B1)',
    kind: 'FK constraint',
    table: 'framework_resparkable_space',
    probe: absent(
      constraintExists('framework_resparkable_space_userId_fkey'),
      'the pre-phase-45 cascade FK is still present: the key migration is half applied'
    ),
  });

  // B2 — the pgvector column itself, asserted by TYPE rather than by presence.
  //
  // The schema file has claimed "Probe B2 asserts the column exists" since the
  // table was written, and until 2026-08-26 it did not: B2 was the one probe in
  // the series with no implementation, so the tier's largest column was the one
  // unmodellable object nothing guarded. Nobody noticed, which is exactly the
  // failure mode the probes exist for.
  //
  // Type rather than presence, because presence was never the risk. Prisma
  // models this as `Unsupported("halfvec(1536)")`, so a regenerated migration
  // will re-emit it as *something* — and a column called `embedding` holding
  // `vector` instead of `halfvec` doubles the largest object in the database
  // (scale.md S1) while every query keeps working. `repo/embeddings.ts` casts
  // to `::halfvec` explicitly, and Postgres will happily coerce, so there is no
  // error anywhere.
  registerAppDriftProbe({
    name: 'B2 framework_resparkable_embedding.embedding (halfvec(1536), not vector)',
    kind: 'pgvector column type',
    table: 'framework_resparkable_embedding',
    probe: columnHasType('framework_resparkable_embedding', 'embedding', 'halfvec'),
  });

  // B3 — INVERTED 2026-08-25. This index must NOT exist (scale.md S3).
  //
  // It was registered as a required object for a year on the belief that vector
  // search used it. It never did: `hybridSearchRows`'s distance pre-filter and
  // its blended `ORDER BY final_score` each independently defeat pgvector's
  // index path, which that query's own doc comment has said all along. pgvector
  // HNSW stores a full copy of every vector, so at the target scale this index
  // cost roughly as much as the table it indexed, for nothing.
  //
  // It comes back only with the inner-CTE rewrite (S4), which changes recall
  // semantics and so arrives as a decision rather than a restoration.
  registerAppDriftProbe({
    name: 'B3 idx_framework_resparkable_embedding_hnsw (MUST NOT EXIST)',
    kind: 'forbidden index',
    table: 'framework_resparkable_embedding',
    probe: absent(
      indexExists('idx_framework_resparkable_embedding_hnsw'),
      'HNSW index is back. No query can use it (hybrid-search.ts blends and pre-filters), ' +
        'and it costs roughly the size of the table. Drop it, or land S4 first — see scale.md S3.'
    ),
  });

  // B4 — tasks are deliberately not embedded (plan §1), so this tsvector IS
  // task search. Losing it is a breakage, not a degradation.
  registerAppDriftProbe({
    name: 'B4 framework_resparkable_task.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_resparkable_task',
    probe: generatedColumnExists('framework_resparkable_task', 'searchVector'),
  });

  // B5 — GIN over B4.
  registerAppDriftProbe({
    name: 'B5 idx_framework_resparkable_task_search_vector (GIN)',
    kind: 'GIN index',
    table: 'framework_resparkable_task',
    probe: indexExists('idx_framework_resparkable_task_search_vector'),
  });

  // B6 — the BM25 half of hybrid search, and the only reason archived items
  // stay findable by keyword once their vectors are deleted (plan §11).
  registerAppDriftProbe({
    name: 'B6 framework_resparkable_embedding.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_resparkable_embedding',
    probe: generatedColumnExists('framework_resparkable_embedding', 'searchVector'),
  });

  // B7 — INVERTED 2026-08-25, same reasoning as B3 (scale.md S3).
  //
  // B6's generated column stays and is still required: `hybridSearchRows` reads
  // `searchVector` for the BM25 half of the blend. What it never does is match
  // against it with `@@`, so the GIN index is not consulted. Note this is NOT
  // B5 (`idx_framework_resparkable_task_search_vector`), which IS used, by
  // `searchTaskKeywords`, and remains a required object above.
  registerAppDriftProbe({
    name: 'B7 idx_framework_resparkable_embedding_search_vector (MUST NOT EXIST)',
    kind: 'forbidden index',
    table: 'framework_resparkable_embedding',
    probe: absent(
      indexExists('idx_framework_resparkable_embedding_search_vector'),
      'GIN index is back. hybridSearchRows computes ts_rank_cd over the userId-filtered set ' +
        'and carries no @@ predicate, so it is never consulted — see scale.md S3.'
    ),
  });

  // B8 — Art. 17 for the GRANTEE, and the reason it needs its own probe.
  //
  // B1 guards the owner cascade. This one guards the other direction, which the
  // default gets wrong: `ResparkableGrant.userId` is the OWNER, so nothing
  // cascades to a grant row when the *grantee* is erased. `ON DELETE SET NULL`
  // — the shape a regenerated migration would most plausibly reach for — is
  // worse than no constraint at all: it leaves a live grant addressed by
  // `granteeEmail`, retained personal data belonging to an erased person, on a
  // row they cannot reach.
  //
  // Like B1, it asserts the ACTION rather than mere existence, and for the same
  // reason: this failure surfaces as a regulatory problem, not a stack trace.
  registerAppDriftProbe({
    name: 'B8 framework_resparkable_grant_granteeUserId_fkey (hand-written FK → user, grantee erasure)',
    kind: 'FK constraint',
    table: 'framework_resparkable_grant',
    probe: constraintExists('framework_resparkable_grant_granteeUserId_fkey', 'ON DELETE CASCADE'),
  });

  // B9 — Art. 17 for the person who wrote a comment.
  //
  // The sibling of B8, one table over and for the same reason: `userId` on a
  // comment is the OWNER of the item it sits on, so the owner cascade does not
  // reach the author. What differs is what `SET NULL` would leave behind —
  // B8's case is a live grant addressed by an erased person's email, this one
  // is free text an erased person WROTE, often about themselves, standing on
  // somebody else's row under an author nobody can name.
  //
  // Asserts the ACTION rather than mere existence, like B1 and B8: a migration
  // recreating this as SET NULL breaks nothing a test would notice, and
  // surfaces as a regulatory problem rather than a stack trace.
  registerAppDriftProbe({
    name: 'B9 framework_resparkable_comment_authorUserId_fkey (hand-written FK → user, author erasure)',
    kind: 'FK constraint',
    table: 'framework_resparkable_comment',
    probe: constraintExists('framework_resparkable_comment_authorUserId_fkey', 'ON DELETE CASCADE'),
  });

  // B10 — at most one live default workspace per owner (§24.1).
  //
  // Partial unique indexes are not expressible in Prisma, so this is raw SQL and
  // `migrate dev` will offer to drop it like every other object in this file.
  // What it enforces is a rule §24.2 states as absolute: a user may change their
  // default workspace and may not have none, and may certainly not have two.
  // Dropped, the service keeps working and a concurrent create can leave an
  // account with two defaults, after which "the app opens on your default" and
  // "unnamed capture lands in your default" quietly disagree about which one.
  //
  // Landed by phase 45 rather than by Release 10, even though nothing creates a
  // second workspace yet, because the migration that would add it is the
  // migration over 21 tables and it happens once.
  registerAppDriftProbe({
    name: 'B10 idx_framework_resparkable_space_one_default_per_owner (partial UNIQUE)',
    kind: 'partial unique index',
    table: 'framework_resparkable_space',
    probe: indexDefMatches(
      'idx_framework_resparkable_space_one_default_per_owner',
      'CREATE UNIQUE INDEX',
      '"ownerUserId"',
      'WHERE ("isDefault" AND ("archivedAt" IS NULL))'
    ),
  });

  // B11 — §23.5's authorship keys, all 23 of them, in one probe.
  //
  // One registration rather than 23 because the failure mode is uniform and the
  // check output has to stay readable: at 23 near-identical lines a human stops
  // reading the list, which is the state a drift check exists to avoid.
  registerAppDriftProbe({
    name: 'B11 framework_resparkable_*_createdByUserId_fkey (23 hand-written FKs → user, SetNull)',
    kind: 'FK constraints',
    table: 'framework_resparkable_* (23 satellites)',
    probe: createdByKeysAreSetNull,
  });

  // B12 — the ownership invariant, and the only reason B1's guarantee is real.
  //
  // B1 asserts the cascade exists. This asserts there is nothing the cascade
  // cannot reach: a `personal` space always has an owner, a `group` space never
  // does. Both halves are Art. 17 problems in opposite directions. A personal
  // space with a NULL owner is a brain no erasure can remove and nothing errors;
  // a group space that acquires one is a shared workspace destroyed when a
  // single member closes their account.
  //
  // A NOT NULL cannot express it, because the column has to be nullable for
  // group spaces. That is exactly why it needs a constraint rather than a
  // convention: phase 45 produced two writers that forgot within an hour of the
  // column existing, and both produced unerasable rows in silence.
  registerAppDriftProbe({
    name: 'B12 framework_resparkable_space_owner_kind_coherent (CHECK: personal has an owner, group has none)',
    kind: 'CHECK constraint',
    table: 'framework_resparkable_space',
    probe: constraintDefMatches(
      'framework_resparkable_space_owner_kind_coherent',
      'ownerUserId',
      'personal',
      'group'
    ),
  });

  // B13: the group tables' three keys into `User` (phase 46).
  //
  // The membership key is the one that matters most, and it is the mirror image
  // of B1. B1 keeps a PERSONAL space reachable by erasure; this keeps a
  // MEMBERSHIP reachable by it, while the group space it points at deliberately
  // is not (B12). Both halves of §23.6 are foreign keys, and neither is visible
  // in the Prisma schema, because `User` is Sunrise-owned and this tier may not
  // add a relation field to it.
  //
  // See GROUP_USER_KEYS for why one of the three cascades and two null out.
  registerAppDriftProbe({
    name: 'B13 framework_resparkable_group_*_fkey (3 hand-written FKs → user, Cascade + SetNull)',
    kind: 'FK constraints',
    table: 'framework_resparkable_group_member, framework_resparkable_group_invite',
    probe: groupUserKeysHaveTheirActions,
  });
}
