/**
 * `searchResparkable` — the brain's only search entry point.
 *
 * **One export, and `scope` is a required field of its input.** That is
 * deliberate: this function is the thing an HTTP route, a capability and (phase
 * 7) a workflow step all call, so it is the single place where "did we scope this
 * query?" gets answered. There is no `searchAll`, no `searchUnscoped`, and no
 * overload that takes a `userId` string — an `SpaceScope` is mintable only from a
 * verified session id, so a route param or an LLM tool argument cannot become one
 * (see `repo/space-scope.ts`).
 *
 * ## Three passes, because one corpus has three shapes
 *
 *   1. **Vector + BM25** over `framework_resparkable_embedding` — the semantic half.
 *      Live items only, because archiving deletes vectors by design.
 *   2. **Task tsvector** (`framework_resparkable_task.searchVector`, drift probe B4)
 *      — tasks are deliberately not embedded (plan §1), so this is not a
 *      fallback, it is the whole task search path.
 *   3. **Keyword substring** over the entity tables, but **only** when
 *      `includeArchived` is set. The archived corpus has no vectors at all, so
 *      there is nothing else that could find it (§16.1c requires exactly this:
 *      archived items absent from vector search, present in keyword search).
 *
 * Results from the passes are merged by `(entityType, entityId)`, keeping the
 * best score, so an item that matches both semantically and lexically ranks once
 * rather than twice.
 */

import {
  EMBEDDED_TYPES,
  assertResparkableModelMatchesStoredVectors,
  hybridSearchRows,
  searchTaskKeywords,
  type EmbeddedType,
} from '@/lib/framework/resparkable/repo/embeddings';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import {
  findSummaries,
  keywordSummaries,
  type EntitySummary,
} from '@/lib/framework/resparkable/repo/summaries';
import { logger } from '@/lib/logging';
import { embedText } from '@/lib/orchestration/knowledge/embedder';

/** Every type search can return, including the unembedded one. */
export const SEARCHABLE_TYPES = [...EMBEDDED_TYPES, 'task'] as const;

export type SearchableType = (typeof SEARCHABLE_TYPES)[number];

/**
 * Cosine-distance ceiling. 0.8 mirrors the platform's knowledge-search default:
 * beyond it, results are noise that makes the whole feature feel broken.
 */
const DEFAULT_MAX_DISTANCE = 0.8;

const DEFAULT_LIMIT = 20;

export interface SearchResparkableInput {
  scope: SpaceScope;
  query: string;
  /** Defaults to everything. */
  entityTypes?: readonly SearchableType[];
  limit?: number;
  maxDistance?: number;
  /** Opt in explicitly — see the keyword pass note above. */
  includeArchived?: boolean;
  /**
   * Hide thoughts the capture-time classifier (or the owner) marked
   * `sensitivity: 'sensitive'`. **Unattended callers pass `true`.**
   *
   * Defaults to `false`, and that default is the owner's: a person searching
   * their own brain must find their own notes, including the ones about their
   * health, their money and the people around them. The distinction this draws
   * is not "who may read this" — it is one brain, one owner — but **"is the
   * owner in the room"**. `resparkable-triage` runs at 03:00 and
   * `resparkable-strategist` writes `ResparkableReview` bodies, and reviews are
   * on §13's shareable list; that is a path from a private note to a shareable
   * artefact with nobody watching, and it existed before sharing did.
   *
   * The filter runs in three places for one reason each: the vector CTE, so
   * sensitive chunks never take result slots; the hydration query, as defence in
   * depth where an id crosses back from raw SQL into the ORM; and the archived
   * keyword pass, which has no vectors to have been filtered.
   */
  excludeSensitive?: boolean;
}

export interface SearchHit extends EntitySummary {
  /** 0–1, higher is better. Blended for vector hits, lexical for keyword ones. */
  score: number;
  /** Which pass found it — useful in the UI and essential when debugging recall. */
  matchedBy: 'semantic' | 'keyword';
  /** The chunk text that matched, for semantic hits. */
  snippet: string | null;
}

export interface SearchResparkableResult {
  hits: SearchHit[];
  /** Embedding spend for this query, so callers can attribute it. */
  embedding: { model: string; provider: string; inputTokens: number; costUsd: number } | null;
}

/**
 * Search the owner's brain.
 *
 * Returns `{ hits: [] }` for a blank query rather than embedding whitespace and
 * ranking the entire corpus by noise — a spend, and a nonsense result set.
 */
export async function searchResparkable(
  input: SearchResparkableInput
): Promise<SearchResparkableResult> {
  const query = input.query.trim();
  if (query.length === 0) return { hits: [], embedding: null };

  const limit = input.limit ?? DEFAULT_LIMIT;
  const maxDistance = input.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const includeArchived = input.includeArchived ?? false;
  const excludeSensitive = input.excludeSensitive ?? false;
  const requested = input.entityTypes ?? SEARCHABLE_TYPES;

  const embeddedTypes = requested.filter((type): type is EmbeddedType => type !== 'task');
  const wantsTasks = requested.includes('task');

  // Before spending an embedding round trip — a dimension mismatch would fail
  // the SQL cast afterwards, which is a confusing way to learn the model changed.
  // Scoped, so the check costs one indexed aggregate over the caller's own chunks
  // rather than a scan of every user's.
  await assertResparkableModelMatchesStoredVectors(input.scope);

  const merged = new Map<string, SearchHit>();
  let embedding: SearchResparkableResult['embedding'] = null;

  // ── Pass 1: semantic ───────────────────────────────────────────────────────
  if (embeddedTypes.length > 0) {
    const embedResult = await embedText(query, 'query');
    embedding = {
      model: embedResult.model,
      provider: embedResult.provider,
      inputTokens: embedResult.inputTokens,
      costUsd: embedResult.costUsd,
    };

    const rows = await hybridSearchRows(input.scope, {
      embedding: embedResult.embedding,
      query,
      entityTypes: embeddedTypes,
      // Over-fetch: several chunks of one document collapse to one hit, so
      // fetching exactly `limit` chunks can yield far fewer than `limit` items.
      limit: limit * 3,
      maxDistance,
      excludeSensitive,
    });

    const byType = groupIdsByType(rows.map((row) => ({ ...row, type: row.entityType })));

    const summaries = await hydrate(input.scope, byType, includeArchived, excludeSensitive);

    for (const row of rows) {
      const key = `${row.entityType}:${row.entityId}`;
      const summary = summaries.get(key);
      // A hit with no summary means the row was archived (its vectors should
      // already be gone) or deleted between the two queries. Dropping it is
      // correct: never render an id we can't resolve to current content.
      if (!summary) continue;

      const existing = merged.get(key);
      if (existing && existing.score >= row.finalScore) continue;

      merged.set(key, {
        ...summary,
        score: clamp(row.finalScore),
        matchedBy: 'semantic',
        snippet: row.content.slice(0, 300),
      });
    }
  }

  // ── Pass 2: tasks, via their generated tsvector ────────────────────────────
  const taskRows = wantsTasks
    ? await searchTaskKeywords(input.scope, query, limit, includeArchived)
    : [];

  if (taskRows.length > 0) {
    const taskSummaries = await findSummaries(
      input.scope,
      'task',
      taskRows.map((row) => row.id),
      includeArchived
    );
    const byId = new Map(taskSummaries.map((summary) => [summary.id, summary]));

    for (const row of taskRows) {
      const summary = byId.get(row.id);
      if (!summary) continue;
      merged.set(`task:${row.id}`, {
        ...summary,
        score: clamp(row.score),
        matchedBy: 'keyword',
        snippet: null,
      });
    }
  }

  // ── Pass 3: the archived corpus, keyword-only ──────────────────────────────
  if (includeArchived && embeddedTypes.length > 0) {
    for (const entityType of embeddedTypes) {
      const rows = await keywordSummaries(
        input.scope,
        entityType,
        query,
        limit,
        true,
        excludeSensitive
      );
      for (const summary of rows) {
        const key = `${entityType}:${summary.id}`;
        if (merged.has(key)) continue;
        merged.set(key, {
          ...summary,
          // Substring matching gives no ranking signal. A fixed, deliberately
          // modest score keeps these below real semantic hits instead of
          // inventing a number that looks like a similarity.
          score: 0.2,
          matchedBy: 'keyword',
          snippet: null,
        });
      }
    }
  }

  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  logger.info('Resparkable search', {
    queryLength: query.length,
    types: requested.length,
    includeArchived,
    excludeSensitive,
    hits: hits.length,
  });

  return { hits, embedding };
}

function clamp(score: number): number {
  return Math.min(1, Math.max(0, score));
}

function groupIdsByType(
  rows: Array<{ type: string; entityId: string }>
): Map<EmbeddedType, string[]> {
  const grouped = new Map<EmbeddedType, string[]>();
  for (const row of rows) {
    const type = row.type as EmbeddedType;
    const ids = grouped.get(type);
    if (ids) ids.push(row.entityId);
    else grouped.set(type, [row.entityId]);
  }
  return grouped;
}

/** One `findMany` per type, keyed for O(1) lookup while ranking. */
async function hydrate(
  scope: SpaceScope,
  byType: Map<EmbeddedType, string[]>,
  includeArchived: boolean,
  excludeSensitive: boolean
): Promise<Map<string, EntitySummary>> {
  const keyed = new Map<string, EntitySummary>();

  for (const [entityType, ids] of byType) {
    const summaries = await findSummaries(
      scope,
      entityType,
      ids,
      includeArchived,
      excludeSensitive
    );
    for (const summary of summaries) {
      keyed.set(`${entityType}:${summary.id}`, summary);
    }
  }

  return keyed;
}
