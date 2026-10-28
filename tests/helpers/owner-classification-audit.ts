/**
 * The owner-classification audit, shared by the coverage guard
 * (`tests/unit/lib/db/owner-classification.test.ts`) and the fork-tier cases
 * (`owner-classification-fork.test.ts`). Pure: it parses schema text and
 * reports what a classification gets wrong against it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { OwnerClassification } from '@/lib/db/owner-classification';

export const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

/** Sunrise's own schema files — the same allowlist, for the same reason, as export-sources.test.ts. */
export const CORE_SCHEMA_FILES = new Set([
  'auth.prisma',
  'base.prisma',
  'mcp.prisma',
  'orchestration-agents.prisma',
  'orchestration-conversations.prisma',
  'orchestration-evaluation.prisma',
  'orchestration-knowledge.prisma',
  'orchestration-ops.prisma',
  'orchestration-providers.prisma',
  'orchestration-workflows.prisma',
  'tenancy.prisma',
  'platform.prisma',
]);

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/** `field Target? @relation(... fields: [a, b] ...)` — a relation whose key lives on this model. */
const FK_RELATION = /^\s*(\w+)\s+(\w+)(\?)?\s+@relation\(([^)]*)\)/;
const FK_FIELDS = /\bfields:\s*\[([^\]]*)\]/;
const SCALAR = /^\s*(\w+)\s+(\w+)(\?)?(\s|$)/;
const USER_SCALAR = new Set([
  'userId',
  'createdBy',
  'uploadedBy',
  'ownerId',
  'actorUserId',
  'subjectUserId',
]);

interface Relation {
  target: string;
  optional: boolean;
  keys: string[];
}
export interface SchemaModel {
  name: string;
  scalars: Map<string, { type: string; optional: boolean }>;
  relations: Map<string, Relation>;
}

/** Parse model blocks: scalar columns and the foreign-key relations this model holds. */
export function parseSchema(texts: string[]): Map<string, SchemaModel> {
  const out = new Map<string, SchemaModel>();
  for (const text of texts) {
    let current: SchemaModel | null = null;
    for (const line of text.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        current = { name: open[1], scalars: new Map(), relations: new Map() };
        out.set(current.name, current);
        continue;
      }
      if (line.startsWith('}')) {
        current = null;
        continue;
      }
      if (!current || /^\s*(\/\/|@@)/.test(line)) continue;
      const rel = FK_RELATION.exec(line);
      if (rel) {
        const keys = FK_FIELDS.exec(rel[4]);
        if (keys) {
          current.relations.set(rel[1], {
            target: rel[2],
            optional: rel[3] === '?',
            keys: keys[1].split(',').map((k) => k.trim()),
          });
        }
        continue;
      }
      const scalar = SCALAR.exec(line);
      if (scalar && !line.includes('@relation')) {
        current.scalars.set(scalar[1], { type: scalar[2], optional: scalar[3] === '?' });
      }
    }
  }
  return out;
}

function userColumnsOf(model: SchemaModel): Set<string> {
  const cols = new Set<string>();
  for (const rel of model.relations.values()) {
    if (rel.target === 'User') rel.keys.forEach((k) => cols.add(k));
  }
  for (const name of model.scalars.keys()) if (USER_SCALAR.has(name)) cols.add(name);
  return cols;
}

/**
 * Everything wrong with `classification` against `schema`, as messages. Pure,
 * so the rules are exercised on synthetic schemas as well as the real one.
 */
export function auditOwnerClassification(
  schema: Map<string, SchemaModel>,
  classification: Record<string, OwnerClassification>,
  /** Models a fork tier classified — `Object.keys(appOwnerClassifications())`. */
  forkModels: ReadonlySet<string> = new Set()
): string[] {
  const problems: string[] = [];
  const personal = new Set(
    Object.entries(classification)
      .filter(([, c]) => c.kind === 'personal')
      .map(([m]) => m)
  );

  const required = new Set<string>();
  for (const model of schema.values()) {
    if (userColumnsOf(model).size > 0) required.add(model.name);
    for (const rel of model.relations.values()) {
      if (personal.has(rel.target) && rel.target !== model.name) required.add(model.name);
    }
  }

  for (const name of [...required].sort()) {
    if (!(name in classification)) {
      problems.push(`${name} links to a user or to a personal model and is not classified`);
    }
  }

  for (const [name, c] of Object.entries(classification)) {
    const model = schema.get(name);
    if (!model) {
      problems.push(`${name} is classified but is not a model in the schema`);
      continue;
    }
    if (!required.has(name)) {
      problems.push(`${name} is classified but links to no user and no personal model`);
    }
    if (c.kind === 'not-personal') {
      if (!c.because.trim()) problems.push(`${name} is not-personal with no reason`);
      continue;
    }

    let ownerOptional: boolean;
    if ('column' in c.owner) {
      const column = c.owner.column;
      if (!userColumnsOf(model).has(column)) {
        problems.push(`${name}.${column} is not a user column on ${name}`);
        continue;
      }
      ownerOptional = model.scalars.get(column)?.optional ?? false;
    } else {
      const { field, parent } = c.owner.through;
      const rel = model.relations.get(field);
      if (!rel || rel.target !== parent) {
        problems.push(`${name}.${field} is not a foreign-key relation to ${parent}`);
        continue;
      }
      if (!personal.has(parent)) {
        problems.push(`${name} is personal through ${parent}, which is not personal`);
        continue;
      }
      const p = classification[parent];
      if (c.enforced && p.kind === 'personal' && !p.enforced) {
        // readOwnerSchema refuses this at client construction, which fails
        // every query in the app — so it is caught here first.
        problems.push(`${name} is enforced but its parent ${parent} is not`);
      }
      ownerOptional = rel.optional;
    }

    if (c.ownerless && !ownerOptional) {
      problems.push(`${name} declares an ownerless arm but its owner can never be missing`);
    }
    // A fork model may not borrow a core ownerless kind (the registry refuses
    // it), so its ownerless rows are readable by no narrowed caller by design.
    if (!c.ownerless && ownerOptional && !forkModels.has(name)) {
      problems.push(
        `${name}'s owner can be missing but it declares no ownerless arm, so its ownerless rows are readable by no narrowed caller`
      );
    }
    for (const col of ['isSystem', 'isTemplate']) {
      if (model.scalars.has(col))
        problems.push(`${name} is personal but carries platform-row column ${col}`);
    }
    if (model.scalars.get('scope')?.type === 'String') {
      problems.push(`${name} is personal but carries a platform-row scope column`);
    }
  }
  return problems;
}

/**
 * Every schema file — core's and the fork tiers'. A fork model links to core
 * models (`User`, a personal parent), so the two are audited as one schema.
 */
export function fullSchema(): Map<string, SchemaModel> {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'));
  return parseSchema(files.map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8')));
}

/** Sunrise's own schema files only — for fixtures that add a synthetic fork tier. */
export function coreSchema(): Map<string, SchemaModel> {
  const files = readdirSync(SCHEMA_DIR).filter((f) => CORE_SCHEMA_FILES.has(f));
  return parseSchema(files.map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8')));
}
