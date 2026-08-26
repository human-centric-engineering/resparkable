/**
 * Resparkable drift probes — the seven Postgres objects Prisma cannot model.
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
 * Source of truth for all six: the Group B block at the foot of
 * `prisma/migrations/20260728222816_add_second_brain/migration.sql`.
 */

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
 * Register Resparkable's seven probes. Five assert an object EXISTS; B3 and B7
 * assert one does NOT (see `absent`). Idempotent per process is NOT guaranteed —
 * `registerAppDriftProbe` throws on a duplicate name, which is deliberate: a
 * double registration means the host wired this up twice and should know.
 */
export function registerResparkableDriftProbes(): void {
  // B1 — the GDPR cascade. Asserts the ON DELETE action, not just existence:
  // a migration recreating this as ON DELETE RESTRICT would break user erasure
  // while every test still passed, and erasure failures surface as a
  // regulatory problem rather than a stack trace.
  registerAppDriftProbe({
    name: 'B1 framework_resparkable_space_userId_fkey (hand-written FK → user, GDPR cascade)',
    kind: 'FK constraint',
    table: 'framework_resparkable_space',
    probe: constraintExists('framework_resparkable_space_userId_fkey', 'ON DELETE CASCADE'),
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
}
