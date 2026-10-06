/**
 * Coverage guard: every `rev`-carrying Resparkable model is accounted for by
 * the phase-58 optimistic-concurrency wiring (§23.13, plan test 13j).
 *
 * `rev Int @default(0)` was added to seven models in one migration (Decision
 * 3, `.context/framework/resparkable/phase-58-59-plan.md`), but only six have
 * an update route that honours it: the seventh, reviews, has no update route
 * at all; a review is generated whole and later dismissed, never edited.
 *
 * This parses the schema itself rather than trusting a hand-written list to
 * stay matched to it. The risk this guards against is the same one every
 * schema-reading coverage test in this repo guards against (see
 * `lib/privacy/export-sources.ts`'s own test): a model gaining a `rev` column
 * later, with nobody deciding whether its update path needs the same
 * conflict handling, looks exactly like a complete rollout from the outside.
 * Nothing about the schema or the API reveals the gap.
 *
 * @see lib/framework/resparkable/repo/shared.ts: `revWhere`, `REV_BUMP`
 * @see lib/framework/resparkable/services/resources.ts: `revisedUpdate`
 * @see lib/framework/resparkable/validations.ts: the per-type update schemas
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  updateAreaSchema,
  updateEntitySchema,
  updateGoalSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateThoughtSchema,
} from '@/lib/framework/resparkable/validations';

/** A Zod schema, narrowed to the one method this file actually calls. */
interface ParsesInput {
  parse: (input: unknown) => unknown;
}

/**
 * Every Resparkable model that is wired through `revisedUpdate`, mapped to
 * the update schema its route validates against. Keyed by the Prisma model
 * name, not the route's own vocabulary (`'note'`, `'person'`), so this table
 * reads directly against the schema below.
 */
const HANDLED_UPDATE_SCHEMAS: Record<string, ParsesInput> = {
  ResparkableArea: updateAreaSchema,
  ResparkableGoal: updateGoalSchema,
  ResparkableProject: updateProjectSchema,
  ResparkableTask: updateTaskSchema,
  ResparkableThought: updateThoughtSchema,
  ResparkableEntity: updateEntitySchema,
};

const HANDLED = Object.keys(HANDLED_UPDATE_SCHEMAS);

/** Models that carry `rev` but are deliberately outside the rollout, with why. */
const EXCLUDED: Record<string, string> = {
  ResparkableReview: 'no update route; reviews are written whole and dismissed, never edited',
};

const SCHEMA_PATH = path.join(process.cwd(), 'prisma', 'schema', 'framework-resparkable.prisma');

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
const REV_FIELD = /^\s*rev\s+Int\b/;

/**
 * Every model name in the schema whose body declares a bare `rev Int` field.
 *
 * Brace-depth tracked by hand rather than parsed with a real Prisma AST: the
 * schema's own block delimiters are plain `{`/`}`, and every field line in
 * this file is one line, so counting braces is enough to tell "still inside
 * this model" from "a later model reusing the name `rev` for something else".
 */
function modelsWithRevField(): string[] {
  const source = readFileSync(SCHEMA_PATH, 'utf-8');
  const found: string[] = [];
  let currentModel: string | null = null;
  let depth = 0;

  for (const line of source.split('\n')) {
    if (currentModel === null) {
      const opened = MODEL_OPEN.exec(line);
      if (opened) {
        currentModel = opened[1] ?? null;
        depth = 1;
      }
      continue;
    }

    if (REV_FIELD.test(line)) found.push(currentModel);

    for (const char of line) {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
    }
    if (depth <= 0) currentModel = null;
  }

  return found;
}

describe('rev-carrying models vs the phase-58 update wiring (13j)', () => {
  it('is exactly HANDLED ∪ EXCLUDED, with every model in exactly one of the two', () => {
    const revModels = modelsWithRevField();
    // A sanity floor so a schema-parsing regression (e.g. a reformatted file
    // this regex no longer matches) fails loudly as "found nothing" rather
    // than quietly passing an empty comparison.
    expect(revModels.length).toBeGreaterThanOrEqual(7);

    const accountedFor = new Set([...HANDLED, ...Object.keys(EXCLUDED)]);
    const missing = revModels.filter((model) => !accountedFor.has(model));
    expect(missing).toEqual([]);

    // The reverse direction: a model dropped from the schema (or whose `rev`
    // column was removed) must not leave a stale, unverifiable entry behind
    // in either list.
    const revModelSet = new Set(revModels);
    const stale = [...accountedFor].filter((model) => !revModelSet.has(model));
    expect(stale).toEqual([]);

    // No model may appear in both: that would be a contradiction about
    // whether it has an update route at all.
    const overlap = HANDLED.filter((model) => model in EXCLUDED);
    expect(overlap).toEqual([]);
  });

  it.each(HANDLED)("%s's update schema accepts rev: 3 and rejects rev: -1", (model) => {
    const schema = HANDLED_UPDATE_SCHEMAS[model];
    expect(schema).toBeDefined();
    if (!schema) return;

    expect(schema.parse({ rev: 3 })).toMatchObject({ rev: 3 });
    expect(() => schema.parse({ rev: -1 })).toThrow();
  });

  it('every EXCLUDED entry carries a real reason, not a placeholder', () => {
    for (const [model, reason] of Object.entries(EXCLUDED)) {
      expect(model.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
