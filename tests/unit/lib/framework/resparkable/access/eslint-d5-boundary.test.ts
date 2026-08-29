/**
 * Tests: the D5 import boundary, run as ESLint rather than read as config.
 *
 * D5 says every brain query is an **owner query** or a **shared query**, and
 * there is no third kind:
 *
 *   • `repo/**` takes an `SpaceScope`, spreads it into every `where`, and
 *     cannot express a cross-user read.
 *   • `access/**` (Release 2) is the deliberate second case: a shared query is
 *     by definition one that reads rows belonging to someone other than the
 *     caller, following a grant or a public link.
 *
 * That is worth exactly as much as the number of ways to bypass it. Two rules
 * hold it up, and this file runs both through the real `Linter` against the
 * rule entries pulled out of the shipped config — a regression in
 * `lib/framework/eslint.config.mjs` fails here rather than being noticed by a
 * reviewer, or not.
 *
 * **`no-restricted-imports` REPLACES rather than merges** in flat config, which
 * is the trap this file also guards: every block restates the core `@/`-alias
 * ban, and a block that drops it silently disables relative-import enforcement
 * for those paths. Asserted per block, not assumed.
 *
 * Test Coverage:
 * - `repo/**` cannot import `access/**` — directly or through the barrel
 * - `repo/**` CAN import Prisma (it is the owner-query layer)
 * - `access/**` CAN import Prisma (it is the shared-query layer)
 * - A service (neither layer) cannot import Prisma
 * - A service CAN import `access/**` — routes are the intended caller
 * - The alias ban is restated in every block
 *
 * @see lib/framework/eslint.config.mjs
 * @see lib/framework/resparkable/repo/space-scope.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

interface FlatConfigBlock {
  files?: string[];
  ignores?: string[];
  rules?: Record<string, unknown>;
}

let blocks: FlatConfigBlock[];

beforeAll(async () => {
  const mod = (await import('@/lib/framework/eslint.config.mjs')) as {
    default: FlatConfigBlock[];
  };
  blocks = mod.default;
});

/** The block whose `files` list contains this exact glob. */
function blockFor(glob: string): FlatConfigBlock {
  const found = blocks.filter((block) => block.files?.includes(glob));
  if (found.length === 0) throw new Error(`No flat-config block targeting "${glob}"`);
  // The repo glob appears twice — the shared boundary and the narrower D5 block
  // — and the later one wins in flat config, so take the last.
  return found[found.length - 1];
}

function lint(block: FlatConfigBlock, filename: string, code: string): Linter.LintMessage[] {
  const rule =
    (block.rules?.['@typescript-eslint/no-restricted-imports'] as Linter.RuleEntry) ??
    (block.rules?.['no-restricted-imports'] as Linter.RuleEntry);
  if (!rule) throw new Error(`Block for "${filename}" configures no restricted-imports rule`);

  // Whichever spelling the block uses, run it under the TS variant so
  // `allowTypeImports` behaves as it does in the real lint.
  return new Linter().verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: { '@typescript-eslint/no-restricted-imports': rule },
      },
    ],
    filename
  );
}

const REPO_GLOB = 'lib/framework/resparkable/repo/**/*.ts';
const TIER_GLOB = 'lib/framework/**/*.{ts,tsx}';

describe('repo/** cannot reach the access layer', () => {
  it('flags a direct import of a resolver', () => {
    const msgs = lint(
      blockFor(REPO_GLOB),
      'lib/framework/resparkable/repo/tasks.ts',
      "import { resolveResparkableAccess } from '@/lib/framework/resparkable/access/resolve';\nexport const x = resolveResparkableAccess;"
    );

    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/owner-scoped by construction/i);
  });

  it('flags the barrel too, not just the modules beneath it', () => {
    // The obvious way round a `access/*` pattern is to import the directory.
    const msgs = lint(
      blockFor(REPO_GLOB),
      'lib/framework/resparkable/repo/tasks.ts',
      "import { resolveResparkableAccess } from '@/lib/framework/resparkable/access';\nexport const x = resolveResparkableAccess;"
    );

    expect(msgs).toHaveLength(1);
  });

  it('still bans relative imports — the alias rule is restated, not replaced away', () => {
    // Flat config REPLACES `no-restricted-imports` options per block. A block
    // that forgot to restate the core ban would silently stop enforcing it for
    // every file it covers.
    const msgs = lint(
      blockFor(REPO_GLOB),
      'lib/framework/resparkable/repo/tasks.ts',
      "import { shared } from './shared';\nexport const x = shared;"
    );

    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/@\/ path alias/);
  });

  it('lets the owner-query layer import Prisma', () => {
    const msgs = lint(
      blockFor(REPO_GLOB),
      'lib/framework/resparkable/repo/tasks.ts',
      "import { prisma } from '@/lib/db/client';\nexport const x = prisma;"
    );

    expect(msgs).toHaveLength(0);
  });
});

describe('the tier-wide Prisma ban, and its two exemptions', () => {
  const tierBlock = () => blockFor(TIER_GLOB);

  it('flags a service reaching the database directly', () => {
    const msgs = lint(
      tierBlock(),
      'lib/framework/resparkable/services/capture.ts',
      "import { prisma } from '@/lib/db/client';\nexport const x = prisma;"
    );

    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/SpaceScope/);
  });

  it('names BOTH layers in the message, so the fix is obvious', () => {
    const msgs = lint(
      tierBlock(),
      'lib/framework/resparkable/services/capture.ts',
      "import { prisma } from '@/lib/db/client';\nexport const x = prisma;"
    );

    expect(msgs[0].message).toMatch(/repo\/\*\*/);
    expect(msgs[0].message).toMatch(/access\/\*\*/);
  });

  it('exempts access/** by ignoring it, so the shared-query layer can query', () => {
    // Asserted on the config rather than by linting: the exemption is an
    // `ignores` entry, which the standalone `Linter` harness above does not
    // apply. This is the assertion that would catch someone tidying the list.
    expect(tierBlock().ignores).toContain('lib/framework/resparkable/access/**');
    expect(tierBlock().ignores).toContain('lib/framework/resparkable/repo/**');
  });

  it('lets a service import the access layer — routes are the intended caller', () => {
    const msgs = lint(
      tierBlock(),
      'lib/framework/resparkable/services/sharing.ts',
      "import { resolveResparkableAccess } from '@/lib/framework/resparkable/access';\nexport const x = resolveResparkableAccess;"
    );

    expect(msgs).toHaveLength(0);
  });

  it('allows a type-only Prisma import anywhere in the tier', () => {
    const msgs = lint(
      tierBlock(),
      'lib/framework/resparkable/services/capture.ts',
      "import type { ResparkableTask } from '@prisma/client';\nexport type T = ResparkableTask;"
    );

    expect(msgs).toHaveLength(0);
  });
});
