-- Resparkable scale foundations: S1 (halfvec) and S3 (prune unused indexes).
-- See .context/framework/resparkable/scale.md.
--
-- ⚠️ THE STANDING PRISMA-DIFF WARNING APPLIES TO THIS MIGRATION TOO.
-- `prisma migrate dev` cannot model pgvector column types, HNSW/GIN indexes,
-- generated columns, or the hand-written FK into "user". If you regenerate a
-- migration from a schema diff it will try to "restore" the two indexes this
-- file deliberately drops, and will re-emit the column as `vector`. Both are
-- wrong. Drift probes B3 and B7 fail the build if that happens, which is the
-- point of flipping them to forbidden-object probes below.

-- ── S1: vector(1536) → halfvec(1536) ────────────────────────────────────────
--
-- Two bytes per dimension instead of four. The recall difference on normalised
-- OpenAI embeddings does not show up in practice, and at the target scale this
-- table is the single largest object in the database.
--
-- The cast is lossy in the sense that float4 → float2 rounds, so stored vectors
-- shift very slightly. That does not need a re-embed: every stored vector moves
-- the same way, so relative distances are preserved, and the corpus stays
-- self-consistent. `contentHash` is untouched, so nothing re-queues.
--
-- ORDER MATTERS: the HNSW index below is dropped FIRST. Altering the column
-- type under an existing HNSW index forces a full index rebuild on a type the
-- index was not built for, which is slow and pointless when the index is being
-- removed anyway.

-- ── S3: drop the two indexes nothing reads ──────────────────────────────────
--
-- B3, the HNSW index. `hybridSearchRows` cannot use it: the `< maxDistance`
-- pre-filter and the blended `ORDER BY final_score` each independently defeat
-- pgvector's index path, which that query's doc comment has stated since it was
-- written. The index held a full copy of every vector and charged a graph
-- traversal on every insert.
DROP INDEX IF EXISTS "idx_framework_resparkable_embedding_hnsw";

-- B7, the GIN index over this table's generated `searchVector`. Same story: the
-- query computes `ts_rank_cd` over the already-userId-filtered candidate set and
-- carries no `@@` predicate, so the index is never consulted. Note this is NOT
-- B5 (`idx_framework_resparkable_task_search_vector`), which IS used, by
-- `searchTaskKeywords`, and stays.
DROP INDEX IF EXISTS "idx_framework_resparkable_embedding_search_vector";

-- Now the type change, with no index to rebuild.
ALTER TABLE "framework_resparkable_embedding"
    ALTER COLUMN "embedding" TYPE halfvec(1536)
    USING "embedding"::halfvec(1536);
