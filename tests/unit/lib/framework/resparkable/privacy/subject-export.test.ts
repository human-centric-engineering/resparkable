/**
 * Coverage guard: the Resparkable subject-access export vs framework-resparkable.prisma.
 *
 * This is the fork-side twin of core's `export-sources.test.ts`, and
 * `lib/app/data-export.ts` asks for it by name: *"Your tables need the same
 * protection, and core cannot write it for you — the pattern worth copying is a
 * constant listing the tables you export plus a test that greps your own schema
 * file."*
 *
 * The failure it exists to prevent is the quiet one. Adding a table to the brain
 * and forgetting this file does not break anything a user or a test would
 * notice; it just means the next subject-access request is answered with a
 * bundle that looks complete and silently omits whatever the new table held.
 * Nobody can tell from the outside — not the subject, not the operator. So the
 * guard reads the schema rather than trusting the manifest to be current.
 *
 * Test Coverage:
 * - Every model carrying a `spaceId` is exported or excluded with a reason
 * - Every model carrying a user id and NO `spaceId` is claimed by the
 *   cross-subject collector (phase 46: the blind spot below)
 * - The manifest names only models that actually exist (catches a rename)
 * - No model is both exported and excluded
 * - Exclusion reasons are substantive, not a shrug
 * - Section names are unique, so one table cannot overwrite another's data
 * - The schema scan actually finds tables (guard on the guard)
 *
 * The runtime half — that every query is owner-scoped and the inbox token is
 * omitted — is in `subject-export-behaviour.test.ts`.
 *
 * ## The blind spot phase 46 closed
 *
 * This guard scanned for `spaceId` alone, which was complete for exactly as long
 * as every table in the tier hung off a space. `ResparkableGroupMember` and
 * `ResparkableGroupInvite` do not: they are keyed on a person and an address,
 * which is why `repo/subject-export.ts` cannot reach them and why
 * `access/subject-export.ts` answers for them instead. Under the old scan they
 * were invisible, so forgetting them would have shipped a short answer to a data
 * subject with every check in this file still green. That is the same failure
 * the guard exists to prevent, one category over, and the fix is a second scan
 * rather than a longer list.
 *
 * @see lib/framework/resparkable/repo/subject-export.ts
 * @see lib/app/data-export.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RESPARKABLE_SUBJECT_SOURCES,
  RESPARKABLE_EXCLUDED_MODELS,
  RESPARKABLE_EXPORT_SECTIONS,
} from '@/lib/framework/resparkable/repo/subject-export';
import { RESPARKABLE_CROSS_SUBJECT_MODELS } from '@/lib/framework/resparkable/access/subject-export';

const SCHEMA_PATH = path.join(process.cwd(), 'prisma/schema/framework-resparkable.prisma');

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/** A plain column holding the owner's id. Every scoped Resparkable table has one. */
// Phase 45 renamed the tier's owner key. The guard-on-the-guard below is what
// caught this: the regex went blind, `scoped` emptied, and every check in the
// file passed while protecting nothing. That is the whole reason it is there.
const SPACE_SCALAR_FIELD = /^\s*spaceId\s+String/;

/**
 * A plain column naming a PERSON. Broader than the space scan on purpose: a
 * table keyed on a person and not on a space is invisible to the space scan, and
 * that is precisely the category that has to be claimed by somebody.
 */
const USER_SCALAR_FIELD =
  /^\s*(userId|invitedByUserId|authorUserId|granteeUserId|createdByUserId|ownerUserId)\s+String/;

/** Models in the tier's schema that carry a `spaceId`, read from the file itself. */
function scanScopedModels(): Set<string> {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  const scoped = new Set<string>();
  let current: string | null = null;

  for (const line of source.split('\n')) {
    const opened = MODEL_OPEN.exec(line);
    if (opened) {
      current = opened[1]!;
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (current && SPACE_SCALAR_FIELD.test(line)) scoped.add(current);
  }

  return scoped;
}

/**
 * Models carrying a user id but NO space key: the tables the owner-scoped
 * manifest cannot express, which `access/subject-export.ts` answers instead.
 */
function scanPersonKeyedModels(): Set<string> {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  const withUser = new Set<string>();
  const withSpace = new Set<string>();
  let current: string | null = null;

  for (const line of source.split('\n')) {
    const opened = MODEL_OPEN.exec(line);
    if (opened) {
      current = opened[1]!;
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (USER_SCALAR_FIELD.test(line)) withUser.add(current);
    if (SPACE_SCALAR_FIELD.test(line)) withSpace.add(current);
  }

  return new Set([...withUser].filter((model) => !withSpace.has(model)));
}

/** Every model name in the tier's schema, for rename/typo detection. */
function scanAllModels(): Set<string> {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  return new Set(
    source
      .split('\n')
      .map((line) => MODEL_OPEN.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
  );
}

const scoped = scanScopedModels();
const personKeyed = scanPersonKeyedModels();
const allModels = scanAllModels();
const crossSubject = new Set<string>(RESPARKABLE_CROSS_SUBJECT_MODELS);
const exported = new Set(Object.keys(RESPARKABLE_SUBJECT_SOURCES));
const excluded = new Set(RESPARKABLE_EXCLUDED_MODELS.map((entry) => entry.model));

describe('the schema scan itself', () => {
  it('finds the scoped tables it is meant to find', () => {
    // Guard on the guard: if the regex stops matching, every check below passes
    // while protecting nothing.
    expect(scoped.size).toBeGreaterThanOrEqual(15);
    expect(scoped.has('ResparkableThought')).toBe(true);
    expect(scoped.has('ResparkableTask')).toBe(true);
  });

  it('finds the person-keyed tables it is meant to find', () => {
    // Guard on the guard, the same one the space scan carries and for the reason
    // phase 45 discovered: a regex that stops matching leaves every check below
    // passing while protecting nothing.
    expect(personKeyed.size).toBeGreaterThanOrEqual(2);
    expect(personKeyed.has('ResparkableGroupMember')).toBe(true);
    expect(personKeyed.has('ResparkableGroupInvite')).toBe(true);
    // A scoped satellite must NOT land in this set, or the two scans overlap and
    // both checks below become meaningless.
    expect(personKeyed.has('ResparkableTask')).toBe(false);
  });

  it('does not treat the operator singleton as scoped', () => {
    // `ResparkableSettings` is keyed by `slug` and holds no `spaceId`, so it is not a
    // subject's data and must not be demanded of the manifest.
    expect(allModels.has('ResparkableSettings')).toBe(true);
    expect(scoped.has('ResparkableSettings')).toBe(false);
  });
});

describe('coverage', () => {
  it('exports or excludes every table holding a user id', () => {
    const missing = [...scoped].filter((model) => !exported.has(model) && !excluded.has(model));

    expect(
      missing.sort(),
      missing.length === 0
        ? ''
        : `These Resparkable tables hold data about a person but appear in neither ` +
            `RESPARKABLE_SUBJECT_SOURCES nor RESPARKABLE_EXCLUDED_MODELS, so a subject-access ` +
            `export silently omits them: ${missing.join(', ')}. Add each to the ` +
            `manifest, or exclude it with a written reason. ` +
            `See lib/framework/resparkable/repo/subject-export.ts.`
    ).toEqual([]);
  });

  it('claims every table keyed on a person rather than on a space', () => {
    // The phase-46 blind spot. A table with a user id and no `spaceId` cannot be
    // reached by `repo/subject-export.ts` at all, so it has to be claimed by the
    // cross-subject collector or the export omits it in silence.
    const unclaimed = [...personKeyed].filter((model) => !crossSubject.has(model));

    expect(
      unclaimed.sort(),
      unclaimed.length === 0
        ? ''
        : `These Resparkable tables are keyed on a person and NOT on a space, so ` +
            `the owner-scoped manifest cannot reach them, and they are not claimed ` +
            `by RESPARKABLE_CROSS_SUBJECT_MODELS either: ${unclaimed.join(', ')}. ` +
            `A subject-access export silently omits them. Add each to ` +
            `lib/framework/resparkable/access/subject-export.ts and collect it there.`
    ).toEqual([]);
  });

  it('does not claim a table the owner-scoped manifest already covers', () => {
    // The inverse mistake, and it is not cosmetic: a model in both sets would be
    // exported twice, and the second copy would arrive through a collector that
    // does not apply the owner scope. `ResparkableGrant` is the live temptation,
    // because `access/subject-export.ts` genuinely reads it.
    const doubled = [...crossSubject].filter((model) => scoped.has(model));
    expect(doubled.sort()).toEqual([]);
  });

  it('names only models that exist', () => {
    // A rename would otherwise leave a source querying nothing and reporting an
    // empty section for ever — which reads as "you have no tasks", not as a bug.
    const unknown = [...exported, ...excluded].filter((model) => !allModels.has(model));

    expect(unknown.sort()).toEqual([]);
  });

  it('never both exports and excludes a model', () => {
    const both = [...exported].filter((model) => excluded.has(model));

    expect(both).toEqual([]);
  });
});

describe('exclusions', () => {
  it('carry a substantive reason', () => {
    // A one-word reason is how a table nobody wanted to think about ends up
    // excluded. The bar is deliberately the same as core's.
    const unexplained = RESPARKABLE_EXCLUDED_MODELS.filter(
      (entry) => entry.reason.trim().length < 20
    ).map((entry) => entry.model);

    expect(unexplained).toEqual([]);
  });

  it('excludes three tables, each for a reason a reader can check', () => {
    // Kept tight on purpose: the moment "excluded" becomes a habit, the export
    // starts shrinking without anyone deciding that it should. So the list is
    // pinned, and growing it means editing this line and saying why.
    //
    // The first two are derived state: vectors computed from exported text, and
    // worker scheduling computed from an exported timezone and an exported event
    // log. Neither is a table somebody chose not to think about.
    //
    // `ResparkableGroup` (phase 46) is a different kind of entry and the one
    // worth reading carefully. It is not derived and it is not empty. It is
    // excluded from the SPACE-SCOPED manifest because a subject's export runs
    // under `spaceScope(subject.userId)`, their personal space, which no group
    // ever points at — so this source could only ever return an empty section
    // while reading as a complete answer. The subject's actual relationship to
    // the group IS exported, by name and role, through the cross-subject
    // collector, and the test above asserts that collector claims the tables it
    // has to. Nothing is withheld here; it is answered somewhere the manifest
    // can reach.
    expect([...excluded].sort()).toEqual([
      'ResparkableEmbedding',
      'ResparkableGroup',
      'ResparkableJob',
    ]);
  });
});

describe('sections', () => {
  it('are unique, so no table can overwrite another’s data', () => {
    // Two sources sharing a section name would silently drop one of them — the
    // bundle would still look well-formed.
    expect(new Set(RESPARKABLE_EXPORT_SECTIONS).size).toBe(RESPARKABLE_EXPORT_SECTIONS.length);
  });

  it('cover the free-text tables a reader would look for first', () => {
    // The sections whose absence would make the export obviously worthless.
    for (const section of ['thoughts', 'tasks', 'documents', 'people', 'reviews']) {
      expect(RESPARKABLE_EXPORT_SECTIONS).toContain(section);
    }
  });
});
