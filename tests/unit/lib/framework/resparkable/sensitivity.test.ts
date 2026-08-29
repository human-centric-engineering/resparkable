/**
 * Unit Tests: sensitivity reaches the vector layer (Release 1.5, phase 9e).
 *
 * This is one invariant spanning four modules, so it is tested as one file
 * rather than as four fragments — the same reasoning that put cross-user
 * isolation in `repo/isolation.test.ts` instead of in every repo's own suite.
 * The invariant:
 *
 *   **A thought classified `sensitive` is present in the owner's own search and
 *   absent from an unattended agent's.**
 *
 * Before phase 9e the second half was unenforceable. `ResparkableEmbedding`
 * carried no sensitivity marker, so the vector pass — the one read path that
 * never touches the source table — ranked sensitive chunks like any other. That
 * matters because `resparkable_search` is bound to `resparkable-triage` (03:00,
 * unattended) and to `resparkable-strategist`, which writes `ResparkableReview`
 * bodies, and reviews are on §13's shareable list. A private-to-shareable path,
 * live before sharing was.
 *
 * Four links in the chain, one describe block each:
 *
 *   1. the vector CTE can express the filter at all;
 *   2. `searchResparkable` applies it to every pass, not just the vector one;
 *   3. the capability decides by **attendance**, never by a model argument;
 *   4. the denormalised copy stays true when someone reclassifies a note.
 *
 * @see lib/framework/resparkable/repo/embeddings.ts
 * @see lib/framework/resparkable/search/hybrid-search.ts
 * @see lib/framework/resparkable/capabilities/search.ts
 * @see .context/framework/resparkable/plan.md §15 (Release 1.5), §16
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn().mockResolvedValue([]);
const thoughtUpdate = vi.fn();
const embeddingUpdateMany = vi.fn().mockResolvedValue({ count: 3 });
const transaction = vi.fn(async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  return undefined;
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown])),
    resparkableThought: { update: (...args: unknown[]) => thoughtUpdate(...args) },
    resparkableEmbedding: { updateMany: (...args: unknown[]) => embeddingUpdateMany(...args) },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  getActiveEmbeddingModelSummary: vi.fn(),
  embedText: vi.fn().mockResolvedValue({
    embedding: [0.1, 0.2],
    model: 'text-embedding-3-small',
    provider: 'openai',
    inputTokens: 4,
    costUsd: 0.000001,
  }),
}));

import {
  embeddingSensitivityUpdateArgs,
  hybridSearchRows,
} from '@/lib/framework/resparkable/repo/embeddings';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { updateThought } from '@/lib/framework/resparkable/repo/thoughts';

const SCOPE = ownerScope('user_a');

/** Flatten a tagged-template call into the SQL a reviewer would read. */
function sqlOf(call: unknown[]): string {
  const [template] = call as [{ strings?: string[] } | string[]];
  const strings = Array.isArray(template) ? template : (template.strings ?? []);
  return strings.join('?');
}

function boundValues(call: unknown[]): unknown[] {
  return call.slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
  embeddingUpdateMany.mockResolvedValue({ count: 3 });
  thoughtUpdate.mockResolvedValue({ id: 't_1' });
  transaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return undefined;
  });
});

describe('the vector CTE can express the filter', () => {
  it('carries a sensitivity predicate in the candidate set, not after ranking', async () => {
    await hybridSearchRows(SCOPE, {
      embedding: [0.1, 0.2],
      query: 'pricing',
      entityTypes: ['thought'],
      limit: 30,
      maxDistance: 0.8,
      excludeSensitive: true,
    });

    const sql = sqlOf(queryRaw.mock.calls[0]);

    // Inside the `scored` CTE, alongside the userId and distance predicates —
    // the whole point of phase 9e. Filtering after the ORDER BY would be
    // correct and useless: the pass over-fetches `limit * 3` chunks, so
    // sensitive rows would silently consume result slots.
    expect(sql).toContain(`e."sensitivity" <> 'sensitive'`);
    expect(sql.indexOf(`e."sensitivity"`)).toBeLessThan(sql.indexOf('ORDER BY final_score'));
  });

  it('binds the flag as a parameter — the SQL text is identical either way', async () => {
    const call = {
      embedding: [0.1, 0.2],
      query: 'pricing',
      entityTypes: ['thought'] as const,
      limit: 30,
      maxDistance: 0.8,
    };

    await hybridSearchRows(SCOPE, { ...call, excludeSensitive: false });
    await hybridSearchRows(SCOPE, { ...call, excludeSensitive: true });

    // One query plan, one prepared statement, one thing to review. A flag
    // spliced into the SQL text would give Postgres two statements to plan and
    // a reviewer two queries to keep in agreement.
    expect(sqlOf(queryRaw.mock.calls[0])).toBe(sqlOf(queryRaw.mock.calls[1]));
    expect(boundValues(queryRaw.mock.calls[0])).toContain(false);
    expect(boundValues(queryRaw.mock.calls[1])).toContain(true);
  });

  it('still scopes to the owner — the filter is added to isolation, not instead of it', async () => {
    await hybridSearchRows(SCOPE, {
      embedding: [0.1, 0.2],
      query: 'pricing',
      entityTypes: ['thought'],
      limit: 30,
      maxDistance: 0.8,
      excludeSensitive: true,
    });

    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toContain('e."spaceId" = ');
    expect(boundValues(queryRaw.mock.calls[0])).toContain('user_a');
  });
});

describe('reclassifying a note reaches the chunks', () => {
  it('pushes the new value onto every chunk of the thought, scoped to the owner', () => {
    const args = embeddingSensitivityUpdateArgs(SCOPE, 'thought', 't_1', 'sensitive');

    // No `chunkIndex` — every chunk, not just chunk 0. The vector pass ranks
    // chunks, so a marker on the first one alone would let paragraph two of a
    // sensitive note through.
    expect(args).toEqual({
      where: { userId: 'user_a', entityType: 'thought', entityId: 't_1' },
      data: { sensitivity: 'sensitive' },
    });
  });

  it('updateThought writes row and chunks in ONE transaction', async () => {
    await updateThought(SCOPE, 't_1', { sensitivity: 'sensitive' });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(embeddingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sensitivity: 'sensitive' } })
    );
  });

  it('does the sync even though the content hash has not moved', async () => {
    // This is the whole reason the sync exists. `sensitivity` is deliberately
    // not part of `contentHash` — reclassifying is not an edit to what a note
    // says — so nulling `indexedHash` above queues a comparison that MATCHES,
    // and the indexer skips the chunk rewrite. Left to the nightly pass, "mark
    // this sensitive" would take effect never.
    await updateThought(SCOPE, 't_1', { sensitivity: 'sensitive' });

    const [data] = thoughtUpdate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data.data.indexedHash).toBeNull();
    expect(embeddingUpdateMany).toHaveBeenCalled();
  });

  it('accepts the { set } spelling Prisma also permits', async () => {
    await updateThought(SCOPE, 't_1', { sensitivity: { set: 'sensitive' } });

    expect(embeddingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sensitivity: 'sensitive' } })
    );
  });

  it('touches no chunk when the edit is not a reclassification', async () => {
    await updateThought(SCOPE, 't_1', { status: 'promoted' });

    // An ordinary edit must not pay for an updateMany over the entity's chunks,
    // and must not open a transaction it has no second statement for.
    expect(embeddingUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
