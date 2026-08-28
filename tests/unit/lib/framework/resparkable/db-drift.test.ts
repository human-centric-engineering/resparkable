/**
 * Unit Tests: the tier's drift probes, and the inversion two of them carry.
 *
 * ## Why a forbidden-object probe needs a test more than an existence one does
 *
 * A drift probe exists because `prisma migrate dev` computes desired state from
 * the schema and emits `DROP` for any deployed object it cannot represent —
 * silently, in a way a schema-only test suite cannot see. B1 and B4–B6 guard
 * against that in the usual direction: the object must be there.
 *
 * B3 and B7 changed sides on 2026-08-25. The HNSW index and the GIN index over
 * `framework_resparkable_embedding.searchVector` were dropped because no query
 * can use them, and what needs guarding now is that nobody puts them back. That
 * inversion runs through one small wrapper, `absent()`, and if the wrapper were
 * ever written the wrong way round the check would report green while asserting
 * the opposite of what it says — a probe that cannot fail, which is worse than
 * no probe at all because it is read as coverage.
 *
 * So the tests below run the registered probes against a fake `pg_indexes` and
 * assert the polarity in both directions.
 *
 * ## And B2, which did not exist until this file was written
 *
 * The schema file has claimed "Probe B2 asserts the column exists" since the
 * table was written, and B2 was the one probe in the series with no
 * implementation — so the tier's largest column was the one unmodellable object
 * nothing guarded, and nobody noticed for a year. It now asserts the column's
 * *type*, because presence was never the risk: a regenerated migration will
 * re-emit `Unsupported("halfvec(1536)")` as something, and a column called
 * `embedding` holding `vector` instead of `halfvec` doubles the largest object
 * in the database while every query keeps working.
 *
 * Test Coverage:
 * - Seven probes register, under stable names
 * - B3 and B7 pass when the index is ABSENT and fail when it is PRESENT
 * - A failing forbidden probe carries a note explaining what to do
 * - B5 is NOT inverted — it is a different index, and it is genuinely used
 * - B2 fails on a `vector` column, not just on a missing one
 * - The existence probes still pass when their object is present
 *
 * @see lib/framework/resparkable/db-drift.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));

import { registerResparkableDriftProbes } from '@/lib/framework/resparkable/db-drift';
import { getAppDriftProbes, resetAppDriftProbes, type DriftObject } from '@/lib/db/drift-probes';

/**
 * Answer every probe query as though the named objects exist.
 *
 * The three primitives this file uses issue different queries but all return a
 * single row: `indexExists` a `count`, `constraintExists` a `def`,
 * `generatedColumnExists` an `is_generated`. Keying on *any* interpolated value
 * matching lets one fake serve all three — `generatedColumnExists` passes a
 * table name as well as a column, so keying on the first parameter alone would
 * make B4 and B6 unanswerable.
 */
function withExistingObjects(names: string[], embeddingType: string | null = null): void {
  queryRaw.mockImplementation((...args: unknown[]) => {
    const present = args
      .slice(1)
      .some((value) => typeof value === 'string' && names.includes(value));
    return Promise.resolve([
      {
        count: present ? 1n : 0n,
        def: present ? 'ON DELETE CASCADE' : null,
        is_generated: present ? 'ALWAYS' : 'NEVER',
        // B2's query alone reads this. `null` means "no such column", which is
        // a different failure from "wrong type" and carries a different note.
        udt_name: embeddingType,
      },
    ]);
  });
}

function probe(prefix: string): DriftObject {
  const found = getAppDriftProbes().find((entry) => entry.name.startsWith(prefix));
  if (!found) throw new Error(`no probe registered under ${prefix}`);
  return found;
}

const HNSW = 'idx_framework_resparkable_embedding_hnsw';
const EMBEDDING_GIN = 'idx_framework_resparkable_embedding_search_vector';
const TASK_GIN = 'idx_framework_resparkable_task_search_vector';

beforeEach(() => {
  vi.clearAllMocks();
  resetAppDriftProbes();
  registerResparkableDriftProbes();
});

describe('registration', () => {
  it('registers eight probes', () => {
    expect(getAppDriftProbes()).toHaveLength(8);
  });

  it('guards BOTH hand-written FKs into "user", not just the owner one', () => {
    // B1 is the owner cascade; B8 is the grantee's. They are different
    // constraints on different tables solving different halves of Art. 17, and
    // the second is the one the default gets wrong — `ResparkableGrant.userId`
    // is the OWNER, so nothing cascades to a grant row when the GRANTEE is
    // erased. Both assert the ON DELETE action rather than mere existence,
    // because both failures surface as regulatory problems rather than as
    // stack traces.
    expect(probe('B1').kind).toBe('FK constraint');
    expect(probe('B8').kind).toBe('FK constraint');
    expect(probe('B8').table).toBe('framework_resparkable_grant');
  });

  it('refuses a duplicate registration', () => {
    // Deliberate: a double registration means the host wired this up twice and
    // should find out at boot rather than run every probe twice for ever.
    expect(() => registerResparkableDriftProbes()).toThrow();
  });

  it('names the two forbidden probes as forbidden', () => {
    // The name is what appears in `db:drift-check` output, and "OK B3 … (MUST
    // NOT EXIST)" is the line that tells a reader the green means "still gone"
    // rather than "still there".
    expect(probe('B3').name).toContain('MUST NOT EXIST');
    expect(probe('B7').name).toContain('MUST NOT EXIST');
    expect(probe('B3').kind).toBe('forbidden index');
  });
});

describe('B2 — the embedding column must be halfvec, not vector', () => {
  it('passes on halfvec', async () => {
    withExistingObjects(['embedding'], 'halfvec');
    await expect(probe('B2').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails on vector, and says which type it found', async () => {
    // The regression this exists for, and the one `columnExists` could never
    // catch: a column of the right name and the wrong type. Nothing errors —
    // `repo/embeddings.ts` casts to `::halfvec` and Postgres coerces — the
    // table just quietly costs twice what it should.
    withExistingObjects(['embedding'], 'vector');

    const result = await probe('B2').probe();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('expected halfvec, found vector');
  });

  it('distinguishes a missing column from a wrong-typed one', async () => {
    withExistingObjects([]);

    const result = await probe('B2').probe();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('missing entirely');
  });
});

describe('B3 — the HNSW index must NOT exist', () => {
  it('passes when the index is absent', async () => {
    withExistingObjects([]);
    await expect(probe('B3').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails when the index has been recreated', async () => {
    // Not hypothetical. `prisma migrate dev` cannot represent an HNSW index and
    // will happily offer to "restore the missing index" — which a reviewer
    // would wave through, and which costs roughly the size of the largest table
    // in the database plus a graph traversal on every insert, for nothing.
    withExistingObjects([HNSW]);

    const result = await probe('B3').probe();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('HNSW index is back');
    // The note has to say what to do, because the failure names an object the
    // reader has probably never heard of.
    expect(result.note).toContain('scale.md S3');
  });
});

describe('B7 — the GIN index over the embedding tsvector must NOT exist', () => {
  it('passes when the index is absent', async () => {
    withExistingObjects([]);
    await expect(probe('B7').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails when the index has been recreated', async () => {
    withExistingObjects([EMBEDDING_GIN]);

    const result = await probe('B7').probe();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('GIN index is back');
  });
});

describe('B5 — the TASK tsvector index, which is a different index and IS used', () => {
  it('is an existence probe, not an inverted one', () => {
    // The mistake this guards against is inverting B5 along with B3 and B7
    // because all three are "an index on a tsvector". B5 backs
    // `searchTaskKeywords`, which really does carry an `@@` predicate, and
    // dropping it degrades task search to a sequential scan.
    expect(probe('B5').name).not.toContain('MUST NOT EXIST');
    expect(probe('B5').kind).toBe('GIN index');
  });

  it('passes when present and fails when dropped', async () => {
    withExistingObjects([TASK_GIN]);
    await expect(probe('B5').probe()).resolves.toMatchObject({ ok: true });

    withExistingObjects([]);
    await expect(probe('B5').probe()).resolves.toMatchObject({ ok: false });
  });
});

describe('the existence probes are unaffected by the inversion', () => {
  it('B1 passes on a cascade FK that is present', async () => {
    withExistingObjects(['framework_resparkable_space_userId_fkey']);
    await expect(probe('B1').probe()).resolves.toMatchObject({ ok: true });
  });

  it.each(['B4', 'B6'])('%s passes on a GENERATED ALWAYS column', async (id) => {
    // These two answer `is_generated`, so a plain column of the same name is
    // NOT enough — which is the distinction `generatedColumnExists` exists for.
    withExistingObjects(['searchVector']);
    await expect(probe(id).probe()).resolves.toMatchObject({ ok: true });
  });
});
