/**
 * Tests: lib/app/ seams ship as no-op defaults
 *
 * Every `lib/app/*` file is a fork-owned scaffold that Resparkable ships EMPTY. This
 * file exercises the REAL defaults to lock in that contract — a stray default
 * registration would silently apply to every install (a lint rule every fork
 * inherits, an auth email swapped out, a restricted agent's document access
 * widened).
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — filling a seam is EXPECTED to fail a row here
 * ---------------------------------------------------------------------------
 * This test asserts a property every fork is expected to violate: the seams
 * exist precisely so you fill them. When you fill one, **pin the new value**
 * rather than deleting the row:
 *
 *     // BEFORE (Resparkable default)
 *     assert: () => expect(appEslintConfig).toEqual([]),
 *     // AFTER  (fork spreads its own tier config)
 *     assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
 *
 * Pinning keeps the protection for the seams you have NOT filled; deleting the
 * row loses it silently. The table below is the whole surface — one row per
 * seam — so a fork's diff here is a line, not a rewrite. See CUSTOMIZATION.md §4.
 *
 * FORK NOTE (Resparkable): this fork fills nine of these seams — `eslint.config.mjs`
 * (spreads the framework tier), `bootstrap.ts` (boots Resparkable), `rate-limit.ts`
 * (seven per-flow sub-caps), `capabilities.ts` (the seventeen agent tools),
 * `context-contributors.ts` (the per-turn `resparkable` context block),
 * `jobs.ts` (the connection sweep),
 * `admin-nav.ts` (the Resparkable section), `protected-routes.ts` (`/resparkable`),
 * `protected-nav.ts` and `auth-landing.ts`.
 * Each row below is pinned rather than deleted, so a stray addition to a filled
 * seam still fails. The Resparkable boot chain itself is covered by
 * tests/unit/lib/framework/resparkable/scaffold.test.ts.
 *
 * @see lib/app/ · CUSTOMIZATION.md §4
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

// FORK (Resparkable): `lib/app/data-export.ts` is filled here, and it runs TWO
// collectors — one per side of the D5 boundary. `repo/subject-export.ts`
// answers "what is in this person's brain?"; `access/subject-export.ts` answers
// the two questions that are about them but live on somebody else's rows. This
// file is a seam test — it asserts what each `lib/app/*` export IS, not what the
// tier does behind it — so both are stubbed rather than run. Without them the
// row below needs a live database, which no other row here does.
//
// Both mocks are load-bearing and neither is redundant: the seam awaits them in
// a `Promise.all`, so an unmocked collector reaches Prisma no matter what the
// other one does. A third collector added to the seam needs a third line here,
// and will announce itself as a connection error rather than an assertion
// failure — which is what happened when the access-layer collector landed.
//
// A distinct sentinel section per collector, rather than a realistic shape:
// the row below asserts the seam spreads BOTH at the top level, and two
// distinguishable keys are what make a dropped collector visible. The tier's
// real sections are its own guard's subject.
//
// `RESPARKABLE_SUBJECT_SOURCES` and `RESPARKABLE_EXCLUDED_MODELS` are passed
// through from the real module: `initAppSubjectSources()` derives the tier's
// declarations from them, and mocking them away would leave the declaration
// half of that row asserting nothing.
vi.mock('@/lib/framework/resparkable/repo/subject-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/repo/subject-export')>()),
  collectResparkableSubjectData: vi.fn().mockResolvedValue({ ownSection: [] }),
}));
vi.mock('@/lib/framework/resparkable/access/subject-export', () => ({
  collectResparkableCrossSubjectData: vi.fn().mockResolvedValue({ crossSection: [] }),
}));

import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { registerAppCapabilities } from '@/lib/orchestration/capabilities';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { buildContext } from '@/lib/orchestration/chat/context-builder';
import { RESPARKABLE_CAPABILITIES } from '@/lib/framework/resparkable/capabilities/catalogue';
import { RESPARKABLE_CONTEXT_TYPE } from '@/lib/framework/resparkable/context/type';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppContextContributors } from '@/lib/app/context-contributors';
import { initAppNav } from '@/lib/app/admin-nav';
import { publicNavItems, footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { protectedNavItems } from '@/lib/app/protected-nav';
import { appAuthLandingRoute, appAuthLandingLabel } from '@/lib/app/auth-landing';
import { emailOverrides } from '@/lib/app/emails';
import { initApp } from '@/lib/app/bootstrap';
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';
import { initAppGuardFloorContributors } from '@/lib/app/guard-floor-contributors';
import { initAppGuardEventContributors } from '@/lib/app/guard-event-contributors';
import { appAgentFields } from '@/lib/app/agent-fields';
import { appProtectedRoutes } from '@/lib/app/protected-routes';
import { appDisallowedPaths } from '@/lib/app/robots';
import { appEnvSchema } from '@/lib/app/env';
import { footerCopyright } from '@/lib/app/footer';
import { APP_API_KEY_SCOPES } from '@/lib/app/api-key-scopes';
import { listValidApiKeyScopes, CORE_API_KEY_SCOPES } from '@/lib/auth/api-key-scopes';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
import { initLeafApp } from '@/lib/app/leaf-bootstrap';
import { appFrameSrc } from '@/lib/app/csp';
import frameworkEslintConfig from '@/lib/framework/eslint.config.mjs';
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { RESPARKABLE_NAV_ITEM } from '@/lib/framework/resparkable/protected-nav';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';
import { collectAppSubjectData } from '@/lib/app/data-export';
import { appTransferPolicies } from '@/lib/app/data-transfer';
import { occupiedTiers } from '@/lib/app/reserved-tiers';
import {
  getAppSubjectSources,
  getAppExcludedSubjectSources,
  __resetAppSubjectSourceRegistryForTests,
} from '@/lib/privacy/subject-source-registry';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';
import {
  listAppMcpResourceTypes,
  listAllowedMcpResourceUriSchemes,
  __resetAppMcpResourcesForTests,
} from '@/lib/orchestration/mcp/resource-registry';
import {
  listGraders,
  __resetGraderRegistryForTests,
} from '@/lib/orchestration/evaluations/graders/registry';
import {
  ACCOUNT_SURFACES,
  getRegisteredAccountSections,
  __resetAccountSectionRegistryForTests,
} from '@/lib/account-sections/registry';

/**
 * One row per `lib/app/*` seam.
 *
 * - `seam` — the file a fork edits, and the test name.
 * - `risk` — what a stray default here would do to every install. This is the
 *   reason the row exists; keep it accurate if you pin a fork value.
 * - `assert` — runs the REAL default and asserts it registers/overrides nothing.
 *   May be async.
 */
interface SeamDefault {
  seam: string;
  risk: string;
  assert: () => void | Promise<void>;
}

/**
 * Seam files deliberately absent from the table below, with the reason. The
 * drift guard at the bottom of this file allows exactly these two.
 */
/** This file's own repo-relative path — the one place importActual is allowed. */
const THIS_FILE = path.join('tests', 'unit', 'lib', 'app', 'defaults.test.ts');

const UNASSERTED_SEAMS = new Set([
  // Asserted behaviourally instead — see tests/unit/lib/db/drift-probes.test.ts.
  'lib/app/db-drift.ts',
  // The one seam that ships real logic (a classifier) rather than an empty
  // value, so "registers nothing" is not the contract. Covered by its own tests.
  'lib/app/surface.ts',
]);

const SEAM_DEFAULTS: SeamDefault[] = [
  {
    seam: 'lib/app/rate-limit.ts',
    risk: 'a stray tier or rule would re-cap every install',
    // FORK (Resparkable): Sunrise asserts the effective policy is the base policy BY
    // IDENTITY — no app rules at all. Resparkable fills this seam with per-flow
    // sub-caps for its expensive routes (every `/search` request embeds the
    // query; `/reindex` and `/connections/sweep` start batch jobs; `/documents`
    // parses an upload; `/transcribe` ships audio to a paid provider,
    // `/transcribe/image` one photo to a vision model; `/vault`
    // reads every table the brain has, and on import inflates and plans an
    // archive; `/ideate` makes a chat-completion call; `/chat` holds an SSE
    // connection open for a tool loop; `/grants/[id]/invite` and
    // `/groups/[id]/invites` send mail to somebody else; and the two public
    // share-reader rules, which are the
    // exception to everything else in this list — see below).
    // Asserting the exact set keeps the original intent: a stray rule still
    // fails, and so does one that escapes the namespace.
    //
    // The order matters and is the registration order in
    // `lib/framework/resparkable/rate-limit.ts` — a rule spliced in the wrong place
    // is a rule that never matches. `/transcribe/image` is registered ahead of
    // `/transcribe` deliberately: both matchers accept a trailing path, and
    // first-match-wins means the more specific one has to come first or it
    // would be shadowed.
    assert: () => {
      registerAppRateLimits();

      const effective = getEffectiveRateLimitPolicy();
      const appRules = effective.filter((rule) => !RATE_LIMIT_POLICY.includes(rule));

      expect(appRules.map((rule) => String(rule.match))).toEqual([
        // The public share reader, both halves, registered first so neither can
        // be shadowed by a later prefix. `/s/` is the one matcher in this list
        // outside `/api/v1/resparkable/` — the reader page is a server
        // component that calls the service directly rather than fetching its
        // own API, so without it a browser would be uncapped.
        String(/^\/api\/v1\/resparkable\/public(?:\/|$)/),
        String(/^\/s\//),
        // The share invite, the one DAILY cap in the tier and the only one
        // about somebody else's inbox rather than this deployment's bill.
        // Anchored on the `/invite` suffix rather than the `/grants` prefix, so
        // creating, amending and revoking a grant stay on the section's
        // 100/min — only the verb that sends mail is capped at 20/day.
        String(/^\/api\/v1\/resparkable\/grants\/[^/]+\/invite$/),
        // The group invite (phase 46), on the same daily tier and anchored the
        // same way: on the `/invites` suffix, so creating a group, listing
        // members and changing roles stay on the section's 100/min.
        String(/^\/api\/v1\/resparkable\/groups\/[^/]+\/invites$/),
        String(/^\/api\/v1\/resparkable\/search(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/reindex(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/connections\/sweep(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/documents(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/transcribe\/image(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/transcribe(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/vault(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/ideate(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/chat(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/briefing\/regenerate(?:\/|$)/),
      ]);

      // Every AUTHENTICATED Resparkable rule is keyed on the session user, not
      // the IP: that is per-person work, and IP keying would make one household
      // share a search budget. The two public share rules are the deliberate
      // exception — a reader holding a link has no session to key on — and
      // naming them here rather than loosening the check means a third IP-keyed
      // rule appearing without a reason still fails.
      const publicRules = appRules.filter((rule) =>
        [/^\/api\/v1\/resparkable\/public(?:\/|$)/, /^\/s\//].some(
          (matcher) => String(rule.match) === String(matcher)
        )
      );
      expect(publicRules).toHaveLength(2);
      expect(publicRules.every((rule) => rule.key === 'ip')).toBe(true);
      expect(
        appRules
          .filter((rule) => !publicRules.includes(rule))
          .every((r) => r.key === 'session-user')
      ).toBe(true);

      // The catch-all must stay last — app rules are spliced in just ahead of
      // it, and a rule after it would never match.
      expect(effective[effective.length - 1]).toBe(RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1]);
    },
  },
  {
    seam: 'lib/app/capabilities.ts',
    risk: 'a stray capability would be dispatchable on every install',
    // FORK (Resparkable): Sunrise asserts this returns undefined, which was a proxy
    // for "registers nothing" only while the seam was empty. Resparkable fills it,
    // so a `toBeUndefined()` here would pass no matter WHAT was registered —
    // vacuous, and vacuous in the seam whose stray registration is dispatchable
    // on every install. Pin the set instead: an extra tool fails, and so does
    // one that escapes the `resparkable_` namespace.
    assert: () => {
      initAppCapabilities();
      registerAppCapabilities();

      for (const spec of RESPARKABLE_CAPABILITIES) {
        expect(capabilityDispatcher.has(spec.slug), spec.slug).toBe(true);
      }
    },
  },
  {
    seam: 'lib/app/context-contributors.ts',
    risk: 'a stray contributor would inject prompt context into every chat turn',
    // FORK (Resparkable): same reasoning as the row above. Resparkable registers exactly
    // one type, and the assertion is behavioural — `buildContext` for that type
    // must reach a loader rather than the "no context loader" placeholder core
    // falls back to.
    assert: async () => {
      initAppContextContributors();

      // No `userId` on the request, so the Resparkable loader returns '' without
      // touching the database — enough to prove the type resolves to a loader.
      const framed = await buildContext(RESPARKABLE_CONTEXT_TYPE, 'unused');

      expect(framed).toContain(`type: ${RESPARKABLE_CONTEXT_TYPE}`);
      expect(framed).not.toContain('No context loader');
    },
  },
  {
    seam: 'lib/app/admin-nav.ts',
    risk: 'a stray section would appear in every install’s admin sidebar',
    // FORK (Resparkable): Sunrise asserts an empty registry; Resparkable adds one
    // section. Pinning the exact shape keeps the original intent — a stray
    // section still fails — and pins the two things that would break the sidebar
    // if they drifted: the title must not collide with a core section (the
    // registry keys by title, so a collision yields two siblings with the same
    // React key), and the href must match the page that actually exists.
    assert: () => {
      __resetNavRegistryForTests();
      initAppNav();

      const sections = getRegisteredNavSections();
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe('Resparkable');
      expect(sections[0].title).not.toBe('AI Orchestration');
      expect(sections[0].items?.map((item) => item.href)).toEqual(['/admin/resparkable/settings']);
    },
  },
  {
    seam: 'lib/app/public-nav.ts',
    risk: 'a stray non-null list would silently REPLACE the marketing nav',
    assert: () => {
      expect(publicNavItems).toBeNull();
      expect(footerNavItems).toBeNull();
      expect(footerLegalItems).toBeNull();
    },
  },
  {
    seam: 'lib/app/protected-nav.ts',
    risk: 'a stray non-null list would silently REPLACE the authenticated nav',
    // FORK (Resparkable): pinned to the platform default plus one Resparkable link. The
    // point of pinning rather than deleting is that this still fails if a second
    // item appears, or if a platform link is dropped on the way through — the
    // seam REPLACES the default, so losing "Profile" here loses it everywhere
    // with no other symptom.
    assert: () => {
      expect(protectedNavItems).toEqual([
        DEFAULT_PROTECTED_NAV[0],
        RESPARKABLE_NAV_ITEM,
        ...DEFAULT_PROTECTED_NAV.slice(1),
      ]);
      expect(protectedNavItems?.map((item) => item.href)).toEqual([
        '/dashboard',
        '/resparkable',
        '/profile',
        '/settings',
        '/admin',
      ]);
    },
  },
  {
    seam: 'lib/app/auth-landing.ts',
    risk: 'a stray value would send every install somewhere else after login',
    assert: () => {
      expect(appAuthLandingRoute).toBeNull();
      expect(appAuthLandingLabel).toBeNull();
    },
  },
  {
    seam: 'lib/app/footer.ts',
    risk: 'a stray value would rewrite — or silently remove — the attribution line on every install, on both the public and authenticated footers',
    assert: () => expect(footerCopyright).toBeNull(),
  },
  {
    seam: 'lib/app/emails.ts',
    risk: 'a stray override would swap an auth email for every install',
    assert: () => expect(emailOverrides).toEqual({}),
  },
  {
    seam: 'lib/app/data-export.ts',
    risk: 'a stray collector would leak app rows into every install’s subject-access export, and a stray declaration would pre-account for a table nobody decided about',
    // FORK (Resparkable): Sunrise asserts both halves ship empty — no app
    // tables at all. Resparkable fills the seam, because a brain is nothing but
    // personal data and an empty Art. 15 export would answer nothing. Pinned
    // rather than deleted, per the SEAM_DEFAULTS convention resparkable#480
    // established.
    //
    // What the row still guards after re-pinning is the property that made it
    // worth asserting: the two halves agree. Every section the tier DECLARES is
    // a section the collector DELIVERS, which is exactly what
    // `exportUserData()` throws `DeclaredAppSourceMissingError` over — a bundle
    // short by a section reads exactly like a complete answer, and neither the
    // subject nor the operator can tell. A collector or a declaration added
    // without the other fails here rather than in production.
    //
    // The collectors are stubbed (see the mocks at the top), so this asserts the
    // seam's SHAPE. What the tier puts in each section is covered by its own
    // manifest guard,
    // tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts.
    assert: async () => {
      __resetAppSubjectSourceRegistryForTests();
      const declared = getAppSubjectSources();
      const excluded = getAppExcludedSubjectSources();

      // The tier declares; it does not ship empty. A drop to zero means the
      // seam stopped registering, which would silence the fork-accounting rule
      // in export-sources.test.ts for every model at once.
      expect(declared.length).toBeGreaterThan(0);
      expect(excluded.length).toBeGreaterThan(0);

      // Every model in the tier's schema is accounted for exactly once, as a
      // source or an exclusion — never both, never neither.
      const declaredModels = declared.map((source) => source.model);
      const excludedModels = excluded.map((entry) => entry.model);
      expect(declaredModels.filter((model) => excludedModels.includes(model))).toEqual([]);

      // Sections are unique, because a collision would have one source's rows
      // overwrite another's inside the bundle.
      const sections = declared.map((source) => source.section);
      expect(new Set(sections).size).toBe(sections.length);

      // Both collectors are stubbed with a sentinel section each, so what this
      // asserts is the seam's own contribution: it spreads BOTH sides at the
      // top level and wraps neither. A wrapper key would make every declared
      // section undeliverable, and a dropped collector would silently halve the
      // answer. That the tier queries the right rows is its own guard's job.
      const bundle = await collectAppSubjectData({
        userId: 'user-1',
        email: 'user@example.com',
      });

      expect(Object.keys(bundle)).toEqual(['ownSection', 'crossSection']);
    },
  },
  {
    seam: 'lib/app/data-transfer.ts',
    risk: 'a stray policy would put app rows into every install’s account export, and write them back on import',
    // This seam genuinely does ship empty here: `prisma/schema/app.prisma` has
    // no models, so Resparkable has nothing to classify through it. The tier's
    // own brain tables are declared one level down, in
    // lib/framework/resparkable/transfer/policy.ts, and reach the registry from
    // there rather than through this file.
    //
    // Completeness is enforced separately and more strongly than for the export
    // seam above: tests/unit/lib/portability/policy-coverage.test.ts reads the
    // generated model graph — which covers every schema file including
    // app.prisma — and fails until every model is classified. So a fork cannot
    // forget to fill this; it can only decide what goes in it.
    assert: () => {
      expect(appTransferPolicies.policies).toEqual([]);
      expect(appTransferPolicies.excluded).toEqual([]);
      expect(appTransferPolicies.crossBoundaryEdges).toEqual([]);
    },
  },
  {
    seam: 'lib/app/bootstrap.ts',
    risk: 'a stray default would run one-time work on every install boot',
    // That instrumentation calls this in all envs, try/catch-isolated, is
    // covered by tests/unit/instrumentation.test.ts.
    //
    // FORK (Resparkable): Sunrise ships an empty async fn; Resparkable fills it to boot
    // its tier. What still matters — and is asserted — is that the boot chain
    // resolves cleanly with no return value, since instrumentation.ts awaits it
    // inside a try/catch and a rejection would leave the tier half-booted. The
    // chain itself is covered by lib/framework/resparkable/scaffold.test.ts.
    assert: async () => {
      await expect(initApp()).resolves.toBeUndefined();
    },
  },
  {
    seam: 'lib/app/knowledge-access-contributors.ts',
    risk: 'a stray contributor would widen every restricted agent’s document access',
    // Behavioural reach into the resolver is covered by resolveAgentDocumentAccess.test.ts.
    assert: () => expect(initAppKnowledgeAccessContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-floor-contributors.ts',
    risk: 'a stray contributor would raise the guard floor on every install',
    assert: () => expect(initAppGuardFloorContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-event-contributors.ts',
    risk: 'a stray observer would receive every install’s inline-chat guard events',
    assert: () => expect(initAppGuardEventContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/agent-fields.ts',
    risk: 'a stray descriptor would add a field to every install’s agent form',
    assert: () => expect(appAgentFields).toEqual([]),
  },
  {
    seam: 'lib/app/protected-routes.ts',
    risk: 'a stray path would put a public route behind auth on every install',
    // FORK (Resparkable): the whole second brain is behind auth. Pinned to exactly
    // one prefix — `/s/*` public share links (Release 2) must never appear here,
    // and a stray entry would put a marketing page behind login.
    assert: () => expect(appProtectedRoutes).toEqual(['/resparkable']),
  },
  {
    seam: 'lib/app/robots.ts',
    risk: 'a stray path would de-index a public route on every install',
    // FORK (Resparkable): Sunrise ships this empty. Resparkable fills it with
    // exactly one prefix — `/s/`, the public share reader, where every URL is a
    // bearer credential to one item of one person's brain.
    //
    // Pinned to the exact list rather than asserted non-empty. The failure this
    // guards is silent and total: an entry of `''` or a lone `/` would disallow
    // the entire deployment, and nothing about the generated `robots.txt` would
    // look wrong at a glance. `app/robots.ts` normalises both away, and
    // `tests/unit/app/robots.test.ts` asserts that; this asserts the list a
    // reviewer would have to have agreed to in the first place.
    assert: () => expect(appDisallowedPaths).toEqual(['/s/']),
  },
  {
    seam: 'lib/app/env.ts',
    risk: 'a stray key would make an unset env var fail boot on every install',
    // An empty z.object() accepts (and strips) anything → parses {} to {}.
    assert: () => expect(appEnvSchema.parse({})).toEqual({}),
  },
  {
    seam: 'lib/app/eslint.config.mjs',
    risk: 'a stray flat-config block would apply lint rules to every fork',
    // The root eslint.config.mjs spreads this array last; that spread itself is
    // exercised by every `npm run lint` run.
    //
    // FORK (Resparkable): Sunrise asserts `toEqual([])`. Resparkable fills it with
    // exactly one thing — the framework tier's config, spread FIRST so any later
    // leaf block still wins for its own paths. Asserting identity with the tier
    // array (rather than a shape) keeps the original intent: a stray block added
    // straight to the leaf seam still fails.
    assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
  },
  {
    seam: 'lib/app/jobs.ts',
    risk: 'a stray job would run on every install\u2019s maintenance tick',
    // FORK (Resparkable): Sunrise asserts this is empty. Resparkable fills it
    // with exactly one job — the tick that bills completed runs and drains its
    // own job queue, which is the shape `registerAppJob({ intervalMs })` was
    // argued for upstream (#469).
    //
    // It was `resparkable:connection-sweep` until phase 56, when the sweep
    // stopped being a rotation with a cursor and became one kind of row in
    // `framework_resparkable_job` alongside six others. One registration
    // either way; pinning the exact set keeps the original intent, which is
    // that a *stray* job still fails here.
    assert: () => {
      __resetAppJobsForTests();
      // getAppJobs() triggers the lazy init, so this exercises the REAL seam.
      expect(getAppJobs().map((job) => job.name)).toEqual(['resparkable:job-queue']);
    },
  },
  {
    seam: 'lib/app/user-created.ts',
    risk: 'a stray hook would run on every signup on every install',
    assert: () => expect(initAppUserCreatedHooks()).toBeUndefined(),
  },
  {
    // FORK (Resparkable): not a Sunrise seam. Resparkable re-exposes `/app` to the leaf
    // forks that install it, so `initApp()` boots Resparkable and Resparkable calls this
    // — the leaf tier's own hook. It ships empty for the same reason every seam
    // above does, and the drift guard below would flag it if it had no row.
    seam: 'lib/app/leaf-bootstrap.ts',
    risk: 'a stray default would run one-time work on every Resparkable install’s boot',
    assert: async () => {
      await expect(initLeafApp()).resolves.toBeUndefined();
    },
  },
  {
    seam: 'lib/app/mcp-resources.ts',
    risk: 'a stray handler would expose app data over MCP to every install\u2019s connected clients',
    assert: () => {
      __resetAppMcpResourcesForTests();
      // Both readers trigger the lazy init, so this exercises the REAL seam.
      expect(listAppMcpResourceTypes()).toEqual([]);
      // FORK (Resparkable): the core scheme constant is `resparkable`, not
      // `sunrise` — `CORE_URI_SCHEME` in lib/orchestration/mcp/resource-registry.ts.
      // The row's intent is unchanged: core's own scheme, and nothing else.
      expect(listAllowedMcpResourceUriSchemes()).toEqual(['resparkable']);
    },
  },
  {
    seam: 'lib/app/evaluations.ts',
    risk: 'a stray grader would appear in every install\u2019s metric picker \u2014 and, on a slug core already uses, would silently rescore every run',
    assert: () => {
      // The registry module is driven directly, so core's barrel has not
      // side-effect-registered anything: whatever listGraders() returns here
      // came from the seam. The read triggers the lazy init, so this exercises
      // the REAL file.
      __resetGraderRegistryForTests();
      expect(listGraders()).toEqual([]);
    },
  },
  {
    seam: 'lib/app/account-sections.ts',
    risk: 'a stray section would appear on every install\u2019s /profile and /settings',
    assert: () => {
      __resetAccountSectionRegistryForTests();
      // The read triggers the lazy init, so this exercises the REAL seam.
      for (const surface of ACCOUNT_SURFACES) {
        expect(getRegisteredAccountSections(surface)).toEqual([]);
      }
    },
  },
  {
    seam: 'lib/app/api-key-scopes.ts',
    risk: 'a stray scope would be mintable on every install \u2014 and a name colliding with a core scope would change what an existing key satisfies',
    assert: () => {
      expect(APP_API_KEY_SCOPES).toEqual([]);
      // …and the union it feeds is exactly core, by value not just by length.
      expect(listValidApiKeyScopes()).toEqual([...CORE_API_KEY_SCOPES]);
    },
  },
  {
    seam: 'lib/app/reserved-tiers.ts',
    risk: 'a stray entry would switch OFF the guard that keeps a reserved tier empty — and it is upstream, where core is the only thing that could put a file there, that the guard is the promise rather than a formality',
    // FORK (Resparkable): Sunrise asserts `[]` — it occupies none of them, which
    // is the whole promise. Resparkable IS the framework-layer tier, so it
    // occupies exactly the two `/framework` entries and no others. Pinned to the
    // value rather than deleted, per the SEAM_DEFAULTS convention
    // resparkable#480 established: the row still fails if a leaf tier is
    // switched off here, which is the guard a host project installing
    // Resparkable is relying on.
    assert: () =>
      expect([...occupiedTiers].sort()).toEqual(['.context/framework', 'lib/framework']),
  },
  {
    seam: 'lib/app/brand.ts',
    risk: 'a stray value would rebrand every install — page titles, both footers’ copyright line, the root meta description and every transactional email — and the legal-entity field is a legal-attribution surface, not a cosmetic one',
    // `importActual`, NOT a plain import: tests/setup.ts pins this seam to null
    // for the whole suite so that no core test reads a fork's brand. Importing
    // it normally here would therefore assert the MOCK ships null, which is true
    // by construction and would keep passing in a fork that had filled the real
    // file — turning the one row that tells a fork to pin its value into a row
    // that can never fail.
    // FORK (Resparkable): Sunrise asserts all three ship null. Resparkable sets
    // the product name here — that is where the brand moved in 0.11.0, out of
    // the removed NEXT_PUBLIC_APP_NAME. Pinned rather than deleted: the two
    // fields still null are legal-attribution and meta-description surfaces, and
    // this row is what makes filling one a decision rather than a drift.
    assert: async () => {
      const seam = await vi.importActual<typeof import('@/lib/app/brand')>('@/lib/app/brand');
      expect(seam.appBrandName).toBe('Resparkable');
      expect(seam.appBrandLegalName).toBeNull();
      expect(seam.appBrandDescription).toBeNull();
    },
  },
  {
    seam: 'lib/app/csp.ts',
    risk: 'a stray origin would widen the iframe policy on every install',
    // These values are spliced straight into a response header, so an
    // accidental default here is a security change, not a cosmetic one.
    assert: () => expect(appFrameSrc).toEqual([]),
  },
];

afterEach(() => {
  __resetNavRegistryForTests();
  __resetAccountSectionRegistryForTests();
});

describe('lib/app/ seams ship empty', () => {
  it.each(SEAM_DEFAULTS)('$seam registers nothing by default', async ({ assert }) => {
    await assert();
  });

  it('nothing but this file escapes the suite-wide brand-seam pin', () => {
    // tests/setup.ts mocks `@/lib/app/brand` to null for EVERY test file, so
    // that no core test can read a fork's brand and fail for a reason the fork
    // cannot fix (#660/#661). That guarantee holds across all ~1095 test files
    // by construction, but only while nothing escapes the mock.
    //
    // `vi.importActual` is legitimate here and nowhere else: it is what makes
    // the brand row above assert the REAL scaffold rather than the mock, which
    // is what keeps "seams ship empty" able to fail in a fork.
    //
    // `vi.doUnmock` is never right. It REMOVES the pin instead of restoring it,
    // so every later case in that file sees the real seam. That is not
    // hypothetical: it shipped twice during this change — once in this suite's
    // own brand tests (13 cases failed against a filled seam) and once in
    // layout-metadata, where it was invisible only because every remaining case
    // happened to re-stub first. To go back to the null default mid-file,
    // re-`doMock` it; do not unmock it.
    //
    // Matched by REGEX over vitest's whole unmocking surface, not by two string
    // literals. The literal version missed `vi.unmock` — a third escape route —
    // and was also defeated by double quotes or a line-wrapped call. That is the
    // enumerating-guard failure mode this repo keeps meeting: it fails one
    // instance per round. vitest exposes exactly `unmock` and `doUnmock` for
    // removing a mock, so anchoring on `(?:do)?unmock` is exhaustive over the API
    // rather than over the spellings someone happened to think of.
    const seamPath = String.raw`['"\`]@/lib/app/brand['"\`]`;
    const unmockRe = new RegExp(String.raw`\bvi\s*\.\s*(?:do)?[Uu]nmock\s*\(\s*` + seamPath);
    const actualRe = new RegExp(String.raw`importActual[\s\S]{0,80}?` + seamPath);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        const rel = path.relative(process.cwd(), full);
        if (unmockRe.test(src)) {
          offenders.push(`${rel}: unmocks the pin instead of restoring it`);
        }
        if (actualRe.test(src) && rel !== THIS_FILE) {
          offenders.push(`${rel}: reads the real seam past the pin`);
        }
      }
    };
    walk(path.join(process.cwd(), 'tests'));

    expect(
      offenders,
      'These test files escape the brand-seam pin in tests/setup.ts. A fork that ' +
        'fills lib/app/brand.ts would see its own brand here and fail a core test ' +
        'it cannot fix — the exact class #660 is about. Re-doMock the null values ' +
        'instead of unmocking, and leave importActual to this file.'
    ).toEqual([]);
  });

  it('has a row for every seam file in lib/app/', () => {
    // Drift guard: adding a `lib/app/*` seam without adding a row above would
    // leave it silently unprotected. Reads the directory rather than trusting
    // the table to be complete.
    const dir = path.join(process.cwd(), 'lib/app');
    const onDisk = readdirSync(dir)
      .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => `lib/app/${f}`);

    const covered = new Set(SEAM_DEFAULTS.map((s) => s.seam));
    const missing = onDisk.filter((f) => !covered.has(f) && !UNASSERTED_SEAMS.has(f));
    const stale = [...covered].filter((f) => !onDisk.includes(f));

    expect(missing, 'lib/app/ seam with no row in SEAM_DEFAULTS').toEqual([]);
    expect(stale, 'SEAM_DEFAULTS row for a file that no longer exists').toEqual([]);
  });
});
