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
 * - Every probe registers, under stable names
 * - B3 and B7 pass when the index is ABSENT and fail when it is PRESENT
 * - A failing forbidden probe carries a note explaining what to do
 * - B5 is NOT inverted — it is a different index, and it is genuinely used
 * - B2 fails on a `vector` column, not just on a missing one
 * - The existence probes still pass when their object is present
 * - B1 asserts the COLUMN as well as the action, so a cascade FK of the right
 *   name on the WRONG column fails (phase 45 moved it to `ownerUserId`)
 * - B1b fails while the pre-phase-45 FK is still present
 * - B10 fails on an index that exists but is not UNIQUE and not partial
 * - B11 fails on a `createdByUserId` key that is Cascade rather than SetNull,
 *   and names the table it found it on
 *
 * @see lib/framework/resparkable/db-drift.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));

import {
  CREATED_BY_TABLES,
  registerResparkableDriftProbes,
} from '@/lib/framework/resparkable/db-drift';
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
function withExistingObjects(
  names: string[],
  embeddingType: string | null = null,
  overrides: { def?: string; indexdef?: string } = {}
): void {
  queryRaw.mockImplementation((...args: unknown[]) => {
    const present = args
      .slice(1)
      .some((value) => typeof value === 'string' && names.includes(value));
    return Promise.resolve([
      {
        count: present ? 1n : 0n,
        // A realistic definition, not just the action: since phase 45 B1 asserts
        // the COLUMN too, and a fake that answered `'ON DELETE CASCADE'` alone
        // would make the probe untestable in the one respect that changed.
        def: present
          ? (overrides.def ??
            'FOREIGN KEY ("ownerUserId") REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE CASCADE')
          : null,
        indexdef: present
          ? (overrides.indexdef ??
            'CREATE UNIQUE INDEX idx_framework_resparkable_space_one_default_per_owner ON ' +
              'public.framework_resparkable_space USING btree ("ownerUserId") WHERE ' +
              '("isDefault" AND ("archivedAt" IS NULL))')
          : null,
        is_generated: present ? 'ALWAYS' : 'NEVER',
        // B2's query alone reads this. `null` means "no such column", which is
        // a different failure from "wrong type" and carries a different note.
        udt_name: embeddingType,
      },
    ]);
  });
}

/**
 * Answer B11's query, which is the one probe reading many rows rather than one.
 *
 * It asks for every `framework_resparkable_%_createdByUserId_fkey` at once, so
 * the fake is a table-to-definition map rather than a present/absent flag.
 */
function withCreatedByKeys(rows: Array<{ table_name: string; def: string }>): void {
  queryRaw.mockImplementation(() => Promise.resolve(rows));
}

/** Every satellite B11 expects a key on, answered as correctly configured. */
function allCreatedByKeysHealthy(): Array<{ table_name: string; def: string }> {
  return CREATED_BY_TABLES.map((table_name) => ({
    table_name,
    def: 'FOREIGN KEY ("createdByUserId") REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE SET NULL',
  }));
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
  it('registers every probe under a stable, unique name', () => {
    const names = getAppDriftProbes().map((entry) => entry.name);
    // Not asserted as a number. It was written as "six" in three places and
    // wrong in all of them for months, and a count nobody updates is a test
    // that only ever fails for the wrong reason. What matters is that the
    // series is complete and nothing shadows anything.
    expect(new Set(names).size).toBe(names.length);
    for (const id of [
      'B1 ',
      'B1b ',
      'B2 ',
      'B3 ',
      'B4 ',
      'B5 ',
      'B6 ',
      'B7 ',
      'B8 ',
      'B9 ',
      'B10 ',
      'B11 ',
    ]) {
      expect(names.some((name) => name.startsWith(id))).toBe(true);
    }
  });

  it('guards ALL THREE hand-written FKs into "user", not just the owner one', () => {
    // B1 is the owner cascade. B8 and B9 are the two the default gets wrong,
    // and they get it wrong the same way: `userId` on a grant and on a comment
    // is the OWNER of the item, so nothing cascades to either row when the
    // *other* person — the grantee, the author — is erased. What `SET NULL`
    // would leave behind differs (a live grant addressed by an erased person's
    // email; free text an erased person wrote), and both are Art. 17
    // violations. All three assert the ON DELETE action rather than mere
    // existence, because all three surface as regulatory problems rather than
    // as stack traces.
    expect(probe('B1').kind).toBe('FK constraint');
    expect(probe('B8').kind).toBe('FK constraint');
    expect(probe('B8').table).toBe('framework_resparkable_grant');
    expect(probe('B9').kind).toBe('FK constraint');
    expect(probe('B9').table).toBe('framework_resparkable_comment');
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
  it('B1 passes on a cascade FK that is present, on the right column', async () => {
    withExistingObjects(['framework_resparkable_space_ownerUserId_fkey']);
    await expect(probe('B1 ').probe()).resolves.toMatchObject({ ok: true });
  });

  it.each(['B4', 'B6'])('%s passes on a GENERATED ALWAYS column', async (id) => {
    // These two answer `is_generated`, so a plain column of the same name is
    // NOT enough — which is the distinction `generatedColumnExists` exists for.
    withExistingObjects(['searchVector']);
    await expect(probe(id).probe()).resolves.toMatchObject({ ok: true });
  });
});

describe('phase 45 moved the cascade, and the probe has to notice', () => {
  it('B1 fails on a cascade FK of the right name on the WRONG column', async () => {
    // The failure this exists for. A regenerated migration recreating B1 against
    // the space key rather than `ownerUserId` puts the cascade back where it was
    // before groups, at which point one member closing their account destroys a
    // whole shared workspace. The name is identical; only the definition differs.
    withExistingObjects(['framework_resparkable_space_ownerUserId_fkey'], null, {
      def: 'FOREIGN KEY ("spaceId") REFERENCES "user"(id) ON DELETE CASCADE',
    });
    const result = await probe('B1 ').probe();
    expect(result.ok).toBe(false);
    expect(result.note).toContain('FOREIGN KEY ("ownerUserId")');
  });

  it('B1 fails on the right column with the wrong action', async () => {
    withExistingObjects(['framework_resparkable_space_ownerUserId_fkey'], null, {
      def: 'FOREIGN KEY ("ownerUserId") REFERENCES "user"(id) ON DELETE RESTRICT',
    });
    await expect(probe('B1 ').probe()).resolves.toMatchObject({ ok: false });
  });

  it('B1b fails while the pre-phase-45 FK is still present', async () => {
    // Both keys present is worse than either: the cascade fires from two
    // columns, so a group space that later acquires an `ownerUserId` is
    // destroyed by an unrelated account closure. This is the only check that
    // distinguishes "the migration ran" from "the migration ran to completion".
    withExistingObjects(['framework_resparkable_space_userId_fkey']);
    const result = await probe('B1b').probe();
    expect(result.ok).toBe(false);
    expect(result.note).toContain('half applied');
  });

  it('B1b passes once the old FK is gone', async () => {
    withExistingObjects([]);
    await expect(probe('B1b').probe()).resolves.toMatchObject({ ok: true });
  });
});

describe('B10 — the one-default-per-owner partial unique', () => {
  it('passes on the real index definition', async () => {
    withExistingObjects(['idx_framework_resparkable_space_one_default_per_owner']);
    await expect(probe('B10').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails on an index of the same name that is neither unique nor partial', async () => {
    // The whole reason this probe reads `indexdef` rather than counting rows.
    // `indexExists` is satisfied by any index of that name, and a plain btree
    // called this enforces nothing: the service keeps working and a concurrent
    // create can leave an account holding two default workspaces.
    withExistingObjects(['idx_framework_resparkable_space_one_default_per_owner'], null, {
      indexdef:
        'CREATE INDEX idx_framework_resparkable_space_one_default_per_owner ON ' +
        'public.framework_resparkable_space USING btree ("ownerUserId")',
    });
    const result = await probe('B10').probe();
    expect(result.ok).toBe(false);
    expect(result.note).toContain('CREATE UNIQUE INDEX');
  });

  it('fails when the index is missing entirely', async () => {
    withExistingObjects([]);
    await expect(probe('B10').probe()).resolves.toMatchObject({ ok: false });
  });
});

describe('B12 — the ownership invariant', () => {
  it('passes on the real constraint definition', async () => {
    withExistingObjects(['framework_resparkable_space_owner_kind_coherent'], null, {
      def:
        'CHECK ((((kind = \'personal\'::text) AND ("ownerUserId" IS NOT NULL)) OR ' +
        '((kind = \'group\'::text) AND ("ownerUserId" IS NULL))))',
    });
    await expect(probe('B12').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails on a constraint that has lost the group half', async () => {
    // The half that is easy to lose and expensive to lose: without it a group
    // space can acquire an owner, and one member closing their account then
    // destroys a workspace belonging to thirty people.
    withExistingObjects(['framework_resparkable_space_owner_kind_coherent'], null, {
      def: 'CHECK (("ownerUserId" IS NOT NULL))',
    });
    const result = await probe('B12').probe();
    expect(result.ok).toBe(false);
    expect(result.note).toContain('group');
  });

  it('fails when the constraint is missing entirely', async () => {
    withExistingObjects([]);
    await expect(probe('B12').probe()).resolves.toMatchObject({ ok: false });
  });
});

describe('B11 — the 23 authorship cascades, in one probe', () => {
  it('passes when every satellite has a SetNull key', async () => {
    withCreatedByKeys(allCreatedByKeysHealthy());
    await expect(probe('B11').probe()).resolves.toMatchObject({ ok: true });
  });

  it('fails, and names the table, when one key is Cascade instead of SetNull', async () => {
    // The action is the point, not a detail. Cascade is what a regenerated
    // migration reaches for, because it is the action every other key in this
    // tier uses — and under it one departing member silently deletes a term's
    // worth of a group's shared material, with nothing erroring.
    const rows = allCreatedByKeysHealthy();
    const victim = rows.find((r) => r.table_name === 'framework_resparkable_task');
    if (!victim) throw new Error('fixture no longer covers the task table');
    victim.def =
      'FOREIGN KEY ("createdByUserId") REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE CASCADE';
    withCreatedByKeys(rows);

    const result = await probe('B11').probe();
    expect(result.ok).toBe(false);
    // Named, because "one of 23 is wrong" is not an actionable failure at 3am.
    expect(result.note).toContain('framework_resparkable_task');
  });

  it('fails, and names the table, when a key is missing entirely', async () => {
    withCreatedByKeys(
      allCreatedByKeysHealthy().filter((r) => r.table_name !== 'framework_resparkable_thought')
    );
    const result = await probe('B11').probe();
    expect(result.ok).toBe(false);
    expect(result.note).toContain('framework_resparkable_thought');
  });

  it('covers every satellite that carries the column, by enumeration', () => {
    // The list is written out in `db-drift.ts` rather than discovered from
    // `information_schema`, because a probe that derives its own expectations
    // cannot fail: a table added in phase 46 without the key would simply not
    // be looked for. Asserting the size here is what makes the omission visible.
    expect(CREATED_BY_TABLES).toHaveLength(23);
    expect(new Set(CREATED_BY_TABLES).size).toBe(23);
    for (const table of CREATED_BY_TABLES) {
      expect(table.startsWith('framework_resparkable_')).toBe(true);
    }
  });
});
