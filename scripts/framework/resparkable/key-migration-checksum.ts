/**
 * Phase 45 lossless proof: the tier's owner key renames, and nothing moves.
 *
 * `plan.md` §23.2 rests the whole shape of the key migration on one claim: it
 * "rewrites no rows". A personal space keeps its existing key value, which
 * happens to be a user id, so the change is `ALTER TABLE … RENAME COLUMN` on 24
 * tables rather than an `UPDATE` over every row in the brain. That claim is
 * cheap to make and expensive to be wrong about, because the tables involved are
 * by design the largest thing in the database and the failure shows up as a
 * multi-hour deploy lock on the first large install.
 *
 * Run it before the migration, run it after, diff the two JSON documents.
 *
 *   npm run framework:resparkable:key-checksum -- --out /tmp/before.json
 *   npm run db:migrate:deploy
 *   npm run framework:resparkable:key-checksum -- --out /tmp/after.json
 *   npm run framework:resparkable:key-checksum -- --compare /tmp/before.json /tmp/after.json
 *
 * `--out` rather than a shell redirect on purpose: the env validator and
 * Prisma's query log both write to stdout, so `> file.json` captures a banner
 * and produces a file the compare step rejects as malformed.
 *
 * ## Why a checksum alone is not the proof
 *
 * A content checksum is invariant under a full table rewrite — that is what a
 * rewrite *is*: the same rows in new pages. So a checksum-only run would let the
 * "no rows rewritten" invariant be claimed without being held. Three measures
 * are taken together, and the second is the one that actually answers the
 * question:
 *
 *   1. **Row count and content checksum**, which catch losing or changing data.
 *   2. **`pg_class.relfilenode`** per table *and index*, which changes on every
 *      rewrite and never on a rename or a metadata-only `ADD COLUMN`. This is
 *      the falsifiable one.
 *   3. **`pg_stat_user_tables` tuple counters**, which say how many rows were
 *      actually written rather than how many could have been.
 *
 * The expected result is not "nothing changed anywhere". `framework_resparkable_space`
 * legitimately gains six columns and takes exactly one write per existing row
 * (`ownerUserId`, `kind` and `isDefault` are backfilled), so its checksum is
 * computed over an explicit list of its pre-existing columns and its tuple delta
 * is expected to equal its row count. Every other table must be untouched on all
 * three measures. `--compare` encodes that asymmetry so a human is not left
 * eyeballing two JSON blobs for it.
 *
 * ## Why the checksum survives the rename
 *
 * `md5(t.*::text)` renders a row **positionally**, and `RENAME COLUMN` preserves
 * `pg_attribute.attnum`, so the digest is invariant under the rename by
 * construction rather than by our being careful. Rows are aggregated in hash
 * order rather than by `id`: order-independent, and it needs no assumption about
 * which columns a table has. `TimeZone`, `DateStyle` and `extra_float_digits`
 * are pinned per statement, because otherwise a session setting difference
 * between the two runs renders floats or timestamps differently and reports a
 * data change that did not happen — which matters most on
 * `framework_resparkable_embedding`, whose `halfvec(1536)` column is both the
 * largest thing here and the one most worth proving untouched.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to run
 * anywhere. Read-only: it opens no transaction and writes nothing.
 *
 * Printing goes through `console` rather than `logger` because this is an
 * operator-facing CLI whose stdout is a JSON document meant to be redirected to
 * a file. See the `scripts/**` override in `eslint.config.mjs`.
 *
 * @see .context/framework/resparkable/phase-45-plan.md
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { prisma } from '@/lib/db/client';

/**
 * Columns `framework_resparkable_space` carries *before* phase 45, with the key
 * column named neutrally so the same list works on both sides of the rename.
 *
 * The parent is the one table whose `t.*::text` legitimately differs across the
 * migration, so it cannot use the positional shortcut every satellite uses. The
 * list is written out rather than derived: deriving it from
 * `information_schema` after the migration would silently include the new
 * columns and compare nothing.
 */
const SPACE_PRE_MIGRATION_COLUMNS = [
  'id',
  'inboxToken',
  'timezone',
  'energyProfile',
  'priorityWeights',
  'retentionPolicy',
  'workStyle',
  'connectionStrengthFloor',
  'createdAt',
  'updatedAt',
] as const;

const SPACE_TABLE = 'framework_resparkable_space';

/**
 * One table's measurements. `null` checksum means the table held no rows.
 *
 * Declared as a schema rather than an interface because `--compare` reads two
 * of these back off disk, and a snapshot file is external data: it may have been
 * written by an older revision of this script, hand-edited, or truncated by a
 * redirect that ran out of space. Parsing it is what stops a missing field
 * reading as an unchanged value and reporting a clean run over a file that says
 * nothing (CLAUDE.md: validate at boundaries, never `as` on external data).
 */
const tableSnapshotSchema = z.object({
  table: z.string(),
  keyColumn: z.string().nullable(),
  rows: z.number(),
  checksum: z.string().nullable(),
  relfilenode: z.string(),
  /** `n_tup_ins + n_tup_upd + n_tup_del` since the last stats reset. */
  tuplesWritten: z.number(),
  totalBytes: z.number(),
  /** Index name to `relfilenode`. A rewritten index is a rewritten table. */
  indexes: z.record(z.string(), z.string()),
});

const snapshotSchema = z.object({
  takenAt: z.string(),
  tables: z.array(tableSnapshotSchema),
});

type TableSnapshot = z.infer<typeof tableSnapshotSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

/** Parse a snapshot file, naming the file in the error rather than the field path alone. */
function readSnapshot(path: string): Snapshot {
  const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${path} is not a snapshot this script wrote: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Pin the rendering settings `t.*::text` depends on.
 *
 * `SET LOCAL` would need a transaction; these are plain `SET`s on the pooled
 * connection, which is fine for a read-only script that exits straight after.
 */
async function pinRendering(): Promise<void> {
  await prisma.$executeRawUnsafe(`SET TimeZone = 'UTC'`);
  await prisma.$executeRawUnsafe(`SET DateStyle = 'ISO, YMD'`);
  await prisma.$executeRawUnsafe(`SET extra_float_digits = 3`);
}

/** Every `framework_resparkable_*` table, in a stable order. */
async function listTierTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename LIKE 'framework_resparkable_%'
     ORDER BY tablename
  `;
  return rows.map((row) => row.tablename);
}

/**
 * The owner key's current name on a table, or `null` if it carries neither.
 *
 * Auto-detecting is what lets one script run on both sides of the rename. A
 * table carrying *both* is a half-applied migration, and saying so here is
 * better than reporting a confusing checksum difference later.
 */
async function detectKeyColumn(table: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${table}
       AND column_name IN ('userId', 'spaceId')
  `;
  const names = rows.map((row) => row.column_name);
  if (names.length > 1) {
    throw new Error(`${table} carries both "userId" and "spaceId" — the migration is half applied`);
  }
  return names[0] ?? null;
}

/** Row count plus an order-independent content digest. */
async function measureContent(table: string): Promise<{ rows: number; checksum: string | null }> {
  // The parent gains columns, so it is hashed over an explicit projection.
  // Every satellite uses `t.*::text`, which is positional and therefore
  // invariant under a column rename.
  const projection =
    table === SPACE_TABLE
      ? `ROW(${SPACE_PRE_MIGRATION_COLUMNS.map((c) => `t."${c}"`).join(', ')})::text`
      : `t.*::text`;

  const rows = await prisma.$queryRawUnsafe<Array<{ rows: bigint; checksum: string | null }>>(
    `SELECT count(*)::bigint AS rows,
            md5(string_agg(h, '' ORDER BY h)) AS checksum
       FROM (SELECT md5(${projection}) AS h FROM "${table}" t) s`
  );
  return { rows: Number(rows[0]?.rows ?? 0n), checksum: rows[0]?.checksum ?? null };
}

/** Storage identity for the table and each of its indexes. */
async function measureStorage(
  table: string
): Promise<Pick<TableSnapshot, 'relfilenode' | 'totalBytes' | 'indexes'>> {
  const [heap] = await prisma.$queryRaw<Array<{ relfilenode: bigint; bytes: bigint }>>`
    SELECT c.relfilenode, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ${table}
  `;
  const indexRows = await prisma.$queryRaw<Array<{ relname: string; relfilenode: bigint }>>`
    SELECT i.relname, i.relfilenode
      FROM pg_index x
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema() AND t.relname = ${table}
     ORDER BY i.relname
  `;

  return {
    relfilenode: String(heap?.relfilenode ?? 0n),
    totalBytes: Number(heap?.bytes ?? 0n),
    // Keyed by name, and the names change in this migration — which is why
    // `--compare` matches indexes by relfilenode rather than by key.
    indexes: Object.fromEntries(indexRows.map((r) => [r.relname, String(r.relfilenode)])),
  };
}

/** How many tuples the table has actually had written, ever. */
async function measureTupleWrites(table: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ written: bigint }>>`
    SELECT coalesce(n_tup_ins, 0) + coalesce(n_tup_upd, 0) + coalesce(n_tup_del, 0) AS written
      FROM pg_stat_user_tables
     WHERE schemaname = current_schema() AND relname = ${table}
  `;
  return Number(row?.written ?? 0n);
}

async function takeSnapshot(): Promise<Snapshot> {
  await pinRendering();
  const tables = await listTierTables();
  const measured: TableSnapshot[] = [];

  for (const table of tables) {
    const [keyColumn, content, storage, tuplesWritten] = await Promise.all([
      detectKeyColumn(table),
      measureContent(table),
      measureStorage(table),
      measureTupleWrites(table),
    ]);
    measured.push({ table, keyColumn, ...content, ...storage, tuplesWritten });
  }

  // `new Date()` only labels the document; nothing compares on it.
  return { takenAt: new Date().toISOString(), tables: measured };
}

/**
 * Compare two snapshots and report every violation of the phase-45 invariant.
 *
 * The invariant is asymmetric on purpose (see the header): satellites must be
 * untouched on all three measures, and the parent is allowed exactly one write
 * per row and a checksum computed over its pre-existing columns only.
 */
function compare(before: Snapshot, after: Snapshot): string[] {
  const problems: string[] = [];
  const beforeByTable = new Map(before.tables.map((t) => [t.table, t]));

  if (before.tables.length !== after.tables.length) {
    problems.push(
      `table count changed: ${before.tables.length} before, ${after.tables.length} after`
    );
  }

  for (const now of after.tables) {
    const was = beforeByTable.get(now.table);
    if (!was) {
      problems.push(`${now.table}: present after, absent before`);
      continue;
    }

    if (was.rows !== now.rows) {
      problems.push(`${now.table}: row count ${was.rows} -> ${now.rows}`);
    }
    if (was.checksum !== now.checksum) {
      problems.push(`${now.table}: content checksum changed`);
    }
    if (was.relfilenode !== now.relfilenode) {
      problems.push(
        `${now.table}: relfilenode ${was.relfilenode} -> ${now.relfilenode} (the heap was REWRITTEN)`
      );
    }

    // Index names change in this migration, so compare the multiset of
    // relfilenodes rather than the name-to-node mapping. A renamed index keeps
    // its node; a rebuilt one does not.
    const wasNodes = Object.values(was.indexes).sort().join(',');
    const nowNodes = Object.values(now.indexes).sort().join(',');
    if (wasNodes !== nowNodes) {
      problems.push(`${now.table}: index storage changed (an index was REBUILT, not renamed)`);
    }

    const written = now.tuplesWritten - was.tuplesWritten;
    const allowed = now.table === SPACE_TABLE ? now.rows : 0;
    if (written !== allowed) {
      problems.push(
        `${now.table}: ${written} tuples written, expected ${allowed}` +
          (now.table === SPACE_TABLE ? ' (one backfill write per space row)' : '')
      );
    }

    if (was.keyColumn === 'userId' && now.keyColumn !== 'spaceId') {
      problems.push(`${now.table}: key column is still "${now.keyColumn ?? 'absent'}"`);
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const compareAt = argv.indexOf('--compare');

  if (compareAt !== -1) {
    const [beforePath, afterPath] = argv.slice(compareAt + 1);
    if (!beforePath || !afterPath) {
      console.error('usage: --compare <before.json> <after.json>');
      process.exit(2);
    }
    const after = readSnapshot(afterPath);
    const problems = compare(readSnapshot(beforePath), after);

    if (problems.length === 0) {
      console.log(`OK: ${after.tables.length} tables, zero rows rewritten.`);
      return;
    }
    console.error(`FAILED: ${problems.length} violation(s) of the phase-45 invariant\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const document = JSON.stringify(await takeSnapshot(), null, 2);
  const outAt = argv.indexOf('--out');
  if (outAt === -1) {
    console.log(document);
    return;
  }
  const outPath = argv[outAt + 1];
  if (!outPath) {
    console.error('usage: --out <snapshot.json>');
    process.exit(2);
  }
  writeFileSync(outPath, `${document}\n`);
  console.log(`wrote ${outPath}`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // A missing database is a skip, not a failure: this script must be safe to
    // run in a fresh clone, exactly like the tier's smoke scripts.
    if (/ECONNREFUSED|does not exist|Can't reach database/i.test(message)) {
      console.log(`skipped: no database reachable (${message.split('\n')[0]})`);
      return;
    }
    console.error(message);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
