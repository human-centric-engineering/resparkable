/**
 * Framework-tier ESLint config.
 *
 * Spread by `lib/app/eslint.config.mjs` **before** that file's own leaf blocks,
 * which the root `eslint.config.mjs` in turn spreads after every Resparkable core
 * block. Net order: core → framework (this file) → leaf. A later block wins for
 * overlapping `files`, so the leaf tier can still override the framework tier
 * for its own paths.
 *
 * **`no-restricted-imports` REPLACES, it does not merge.** Flat config does not
 * deep-merge rule options: a block that sets the rule for a glob fully replaces
 * any earlier setting for those files. Every block below therefore restates the
 * core `@/`-alias ban — omitting it would silently kill relative-import
 * enforcement on those paths — and the narrower `repo/**` block restates the
 * whole of the tier-wide block on top of its own rule.
 *
 * See CUSTOMIZATION.md §4, `lib/app/eslint.config.mjs`, and
 * `.context/architecture/lint-toolchain.md`.
 */

/** Restated from the core config — see the replace-not-merge note above. */
const aliasBan = {
  group: ['./*', '../*'],
  message: 'Use the @/ path alias instead of relative imports (CLAUDE.md).',
};

/**
 * The framework tier may only reach into the leaf tier through the two seams
 * Resparkable deliberately re-exposes to its own leaf forks. Anything else is
 * inverted layering: the leaf depends on the framework, not the reverse.
 */
const leafTierBan = {
  group: ['@/lib/app/*', '!@/lib/app/leaf-bootstrap', '!@/lib/app/resparkable'],
  message:
    'The framework tier must not import the leaf app tier. The only exceptions are the ' +
    'seams Resparkable re-exposes to its leaf forks: @/lib/app/leaf-bootstrap and @/lib/app/resparkable.',
};

/**
 * Two layers talk to the database, and each is named for the kind of query it
 * is allowed to write.
 *
 * D5 says every brain query is an **owner query** or a **shared query**, and
 * there is no third kind:
 *
 *   • `repo/**` — owner queries. Every function takes an `OwnerScope` and
 *     spreads it into the `where`, so "cross-user read" is not expressible.
 *   • `access/**` — shared queries (Release 2, §13). A shared query is by
 *     definition one that reads rows belonging to someone other than the
 *     caller, following a grant or a public link. Routing it through `repo/**`
 *     would mean handing the repo layer a way to say "not my rows", which is
 *     precisely the capability that layer exists NOT to have.
 *
 * Everything else — services, routes, capabilities, workflows — goes through
 * one of the two. A direct `prisma` import anywhere else is the bypass that
 * turns D5 back into a convention.
 *
 * The separation is kept honest from the other side too: `repo/**` may not
 * import `access/**` (the block further down), so the two cannot quietly
 * collapse into one layer that does both.
 *
 * `db-drift.ts` is exempt: its probes query `pg_indexes` and
 * `information_schema`, which are server-wide catalogues with no `userId` to
 * scope by.
 */
const prismaBan = {
  group: ['@/lib/db/client', '@prisma/client'],
  allowTypeImports: true,
  message:
    'Only lib/framework/resparkable/repo/** (owner queries) and lib/framework/resparkable/access/** ' +
    '(shared queries) may reach the database. Add a repo function that takes an OwnerScope — a direct ' +
    'prisma import is how an unscoped query gets written (D5). Type-only imports of Prisma model ' +
    'types are fine.',
};

export default [
  // ── Framework-tier import boundary ───────────────────────────────────────
  {
    files: ['lib/framework/**/*.{ts,tsx}'],
    ignores: [
      'lib/framework/resparkable/repo/**',
      'lib/framework/resparkable/access/**',
      'lib/framework/resparkable/db-drift.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [aliasBan, leafTierBan, prismaBan] },
      ],
    },
  },

  // The two database-reaching layers and the drift probes: same boundary minus
  // the Prisma ban. See `prismaBan`'s docblock for why `access/**` is here.
  {
    files: [
      'lib/framework/resparkable/repo/**/*.ts',
      'lib/framework/resparkable/access/**/*.ts',
      'lib/framework/resparkable/db-drift.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [aliasBan, leafTierBan] }],
    },
  },

  // ── D5: owner queries and shared queries are structurally separate ───────
  // `lib/framework/resparkable/repo/*` takes an `OwnerScope` and must not be able
  // to express a cross-user read. Cross-user resolution lives in
  // `lib/framework/resparkable/access/*`, and the repo layer must not reach it —
  // otherwise the "every brain query is an owner query or a shared query"
  // invariant becomes a convention rather than a structure. See the plan, D5.
  {
    files: ['lib/framework/resparkable/repo/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            aliasBan,
            leafTierBan,
            {
              group: ['@/lib/framework/resparkable/access', '@/lib/framework/resparkable/access/*'],
              message:
                'The Resparkable repo layer is owner-scoped by construction (D5) and must not import ' +
                'the cross-user access layer. Put shared-item reads in lib/framework/resparkable/access/*.',
            },
          ],
        },
      ],
    },
  },
];
