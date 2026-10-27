/**
 * Rate-Limit Middleware Dispatcher
 *
 * Consumed by `proxy.ts` at the project root (Next.js 16 renamed the
 * `middleware.ts` file convention to `proxy.ts`). Runs on every API request,
 * looks up the matching tier from {@link RATE_LIMIT_POLICY}, identifies the
 * caller, applies the section limiter, and returns a 429 response if the cap
 * is exceeded — otherwise yields control back to the route handler.
 *
 * Route handlers must NOT call section limiters themselves. They MAY call
 * tighter *per-flow* limiters (chatLimiter, audioLimiter, etc.) as additive
 * checks on expensive sub-flows.
 *
 * **Test bypass.** Setting `RATE_LIMIT_BYPASS=true` makes `applyRateLimit`
 * a no-op. `tests/setup.ts` sets this so the vast majority of unit tests
 * never have to think about rate-limiting. Tests that explicitly exercise
 * the middleware (or a section tier) unset the env var in their own
 * `beforeEach` and reset the limiter state per test.
 *
 * @see lib/security/rate-limit-policy.ts — the policy table this consumes
 * @see lib/security/rate-limit.ts — limiter primitives + the tier registry
 * @see proxy.ts — project-root Next.js wiring
 */

import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { logger } from '@/lib/logging';
import { collapseDynamicSegments } from '@/lib/logging/redact-path';
import { getClientIP } from '@/lib/security/ip';
import {
  createRateLimitResponse,
  resolveRateLimitTier,
  type RateLimiter,
} from '@/lib/security/rate-limit';
import {
  findRateLimitRule,
  getEffectiveRateLimitPolicy,
  isBuiltInRateLimitKey,
  pathMatchesRule,
  resolveAppRateLimitKeyResolver,
  type RateLimitRule,
} from '@/lib/security/rate-limit-policy';
import { resolveRateLimitCredential } from '@/lib/security/rate-limit-credentials';
import { checkOrgRequestCap } from '@/lib/security/org-request-cap';
import { sessionActingOrgId } from '@/lib/tenancy/entry';
import { resolveTenantFromRequest } from '@/lib/tenancy/resolver';
import { API_KEY_PREFIX } from '@/lib/auth/api-keys';
import { isMultiTenant } from '@/lib/tenancy/context';
import { registerAppRateLimits } from '@/lib/app/rate-limit';

// Auto-wire the app's rate-limit registrations (fork-readiness — the `lib/app/`
// bootstrap surface). Runs ONCE when this module loads, which is in the
// middleware runtime — the same realm `proxy.ts` evaluates the policy in, so an
// app-registered tier/rule is present before the first `applyRateLimit` call.
// (Module-level registries don't cross Next.js's middleware/server/client
// bundle boundaries, so each `lib/app/` file is imported by its realm's
// consumer rather than a single shared bootstrap.) Default is a no-op; if a
// fork's registration throws — e.g. a rule that would shadow a protected
// surface — it aborts boot, which is the intended fail-fast.
//
// The try/catch wraps the call to annotate the failure with a pointer to the
// offending file before re-throwing. Without it, the throw propagates out of
// this module's top level → `proxy.ts` fails to load → every API request
// returns a generic 500 with a stack that does NOT name `lib/app/rate-limit.ts`,
// making the debugging trail hard to follow. We MUST re-throw — fail-fast is
// the intended behaviour for a misconfigured rate-limit registration; logging
// and continuing would let the misconfiguration ship.
/**
 * Boot-time integrity walk over the effective policy. The rule shape widens
 * both `tier` and `key` to `… | (string & {})` so forks can name custom
 * values without TS module-augmentation gymnastics; the trade-off is that a
 * typo (`tier: 'billling'`, `key: 'sesion-user'`) type-checks cleanly and
 * would degrade silently at request time — an unresolved tier fails OPEN (no
 * limiter → no cap), an unresolved key falls back to per-IP buckets with a
 * hot-path error log. Convert both into a boot-time throw.
 *
 * The key half is load-bearing for Resparkable's own `RATE_LIMIT_POLICY` too, not
 * just the app-extended slice: built-in rules are a literal array that never
 * passes through `registerRateLimitRule`'s guard, so before this walk a
 * mistyped built-in key in the table would have shipped. Exported so tests
 * exercise both failure modes directly instead of through module re-import.
 */
export function assertRateLimitPolicyIntegrity(
  policy: readonly RateLimitRule[] = getEffectiveRateLimitPolicy()
): void {
  const unresolvedTiers = policy.filter((rule) => resolveRateLimitTier(rule.tier) === undefined);
  if (unresolvedTiers.length > 0) {
    const details = unresolvedTiers.map((r) => `${String(r.match)} → "${r.tier}"`).join(', ');
    throw new Error(
      `Rate-limit policy references ${unresolvedTiers.length} unknown tier(s): ${details}. ` +
        'Either register the tier(s) via registerRateLimitTier(...) in lib/app/rate-limit.ts, ' +
        'or fix the typo in the rule. Boot is aborted rather than shipping silent fail-open.'
    );
  }
  const unresolvedKeys = policy.filter(
    (rule) =>
      !isBuiltInRateLimitKey(rule.key) && resolveAppRateLimitKeyResolver(rule.key) === undefined
  );
  if (unresolvedKeys.length > 0) {
    const details = unresolvedKeys.map((r) => `${String(r.match)} → "${r.key}"`).join(', ');
    throw new Error(
      `Rate-limit policy references ${unresolvedKeys.length} unknown key strategy(ies): ${details}. ` +
        'Either register the resolver via registerRateLimitKeyResolver(...) in ' +
        'lib/app/rate-limit.ts, or fix the typo in the rule. Boot is aborted rather than ' +
        'shipping per-IP fallback buckets and a hot-path error log.'
    );
  }
}

try {
  registerAppRateLimits();
} catch (error) {
  logger.error('Failed to register app rate limits from lib/app/rate-limit.ts', {
    error: error instanceof Error ? error.message : String(error),
    hint: 'A throw at module load aborts the middleware bundle. Check lib/app/rate-limit.ts for a registerRateLimitRule/registerRateLimitTier/registerRateLimitKeyResolver call that violates the registration contract (e.g. a matcher that shadows a Resparkable-protected path, or a tier or key name that collides with a built-in).',
  });
  throw error;
}

// Deliberately a SEPARATE catch from the one above. The integrity check reads
// the assembled policy — Resparkable's own RATE_LIMIT_POLICY as well as any app
// rules — so a mistyped built-in key in the core table lands here. Attributing
// that to lib/app/rate-limit.ts would send a core contributor to a file that
// ships empty.
try {
  assertRateLimitPolicyIntegrity();
} catch (error) {
  logger.error('Rate-limit policy integrity check failed', {
    error: error instanceof Error ? error.message : String(error),
    hint: 'A rule names a tier or key with no definition. The error message names the offending rule(s) — fix the typo at its source: a built-in rule in lib/security/rate-limit-policy.ts, or an app rule/resolver in lib/app/rate-limit.ts. Boot is aborted rather than shipping silent fail-open.',
  });
  throw error;
}

/**
 * Apply the rate-limit policy to an incoming request.
 *
 * Returns a `Response` (status 429) when the cap is exceeded; the caller
 * MUST return that response immediately and skip further middleware /
 * handler execution. Returns `null` when the request is allowed to proceed.
 *
 * Order of operations:
 *   1. Bypass check (`RATE_LIMIT_BYPASS=true` env var, used by the test suite).
 *   2. Find the first matching policy rule. No match → no rate limit.
 *   3. Run the rule's `skip` predicate (if any). True → no rate limit.
 *   4. Build the rate-limit token via the rule's key strategy. Session
 *      resolution happens only for `'session-user'` rules and falls back
 *      to IP if there's no session.
 *   5. Check the section limiter for that token. Exceeded → return the
 *      standard 429 response with `Retry-After` and `X-RateLimit-*` headers.
 *   6. At `multi`, when step 4 identified the caller by a verified principal
 *      that acts for an org, count the request against that org's
 *      `quotas.requestsPerMinute` too (§110 t-789). No cap set, no org, or a
 *      user who cannot enter the org → nothing counted. Exceeded → the same
 *      429, carrying the org's limit. Allowed → return `null`.
 *
 * The org counter runs after the caller's own, so a request the caller's
 * limit refused never spends org capacity: one caller's share of an org's cap
 * is bounded by its own limit. It never runs on {@link ORG_CAP_EXEMPT}.
 * Embed-token traffic is not counted: the token is public, so counting it
 * would let anyone hold a tenant at its cap and lock out its members.
 *
 * Failure modes:
 *   - If session resolution throws (better-auth outage, DB down) we DO NOT
 *     fail-open: we fall back to IP keying so the request still gets a
 *     bucket. The route handler will surface the underlying error.
 *   - If the rule's tier isn't in `RATE_LIMIT_TIERS` (unreachable in
 *     practice — the type system enforces this) we treat it as "no limit"
 *     and log a warning. Open vs closed default here is open: a missing
 *     tier should not break production traffic, only telemetry.
 */
export async function applyRateLimit(request: NextRequest): Promise<Response | null> {
  if (isBypassEnabled()) return null;

  // Evaluate against the effective policy: Resparkable's base rules plus any
  // app-registered rules (spliced ahead of the catch-all). When no app rules
  // are registered this is the base policy by identity — no per-request cost.
  const policy = getEffectiveRateLimitPolicy();

  // First-match-wins, with fall-through on `skip`. A path with two
  // consecutive rules (e.g. the orchestration api-key + session-user pair
  // added in Phase 4) needs the second rule to apply when the first's
  // `skip` fires. `findRateLimitRule` returns the very first path match,
  // so we use it for the typical single-rule case and only iterate the
  // policy directly when that rule's `skip` is true.
  const pathname = request.nextUrl.pathname;
  let rule: RateLimitRule | null = findRateLimitRule(pathname, policy);
  if (rule?.skip?.(request)) {
    rule = null;
    // Re-use the shared matcher so a third matcher shape (or a tweak to the
    // existing string/RegExp semantics) can't silently diverge between
    // `findRateLimitRule` and this fallthrough loop.
    const startIndex = policy.findIndex((r) => pathMatchesRule(r.match, pathname));
    for (let i = startIndex + 1; i < policy.length; i++) {
      const candidate = policy[i];
      if (!pathMatchesRule(candidate.match, pathname)) continue;
      if (candidate.skip?.(request)) continue;
      rule = candidate;
      break;
    }
  }
  if (!rule) return null;

  const limiter: RateLimiter | undefined = resolveRateLimitTier(rule.tier);
  if (!limiter) {
    // Unreachable for built-in rules under normal type-checked code. If it
    // fires, a rule names a tier that `resolveRateLimitTier` can't resolve —
    // either core config drift, or an app rule referencing a tier it never
    // registered via `registerRateLimitTier`. Surface it loudly so operators
    // can fix the config instead of silently failing open.
    logger.warn('Rate-limit policy references an unknown tier; skipping limiter', {
      tier: rule.tier,
      pathname: collapseDynamicSegments(request.nextUrl.pathname),
    });
    return null;
  }

  const caller = await resolveCaller(rule.key, request);
  // Namespaced by tier and key strategy so different sections don't share
  // buckets, and so these tokens don't collide with the per-flow sub-limiter
  // tokens route handlers build with their own conventions (`audio:user:...`).
  const result = limiter.check(`mw:${rule.tier}:${rule.key}:${caller.id}`);
  if (!result.success) {
    return createRateLimitResponse(result);
  }

  if (caller.orgId && !ORG_CAP_EXEMPT.test(pathname)) {
    const orgResult = await checkOrgRequestCap(caller.orgId, caller.memberUserId);
    if (orgResult && !orgResult.success) {
      return createRateLimitResponse(orgResult);
    }
  }
  return null;
}

/**
 * Paths the org request cap never counts — the ways out of a saturated org.
 * Their section tiers still apply.
 *
 * - **The platform admin surface.** It is the vendor's control plane — the
 *   default authorization policy admits only platform admins — and it is
 *   where a saturated cap is raised (`PATCH /api/v1/admin/orgs/[id]`).
 *   Counting it would let a tenant's traffic lock the operator out of the
 *   remedy, and charge the vendor's support work in a customer's org to that
 *   customer.
 * - **`/api/v1/orgs` and `/api/v1/orgs/switch`.** A member of two orgs whose
 *   session names the saturated one must still be able to list their orgs and
 *   move to the other.
 *
 * The admin exemption is by path, which holds while only platform admins
 * reach that surface (the default authorization policy). A fork that admits
 * org admins there lets that traffic past its tenants' caps.
 */
const ORG_CAP_EXEMPT = /^\/api\/v1\/(admin\/|orgs(\/switch)?\/?$)/;

/**
 * Whether the test/dev bypass is active. Set `RATE_LIMIT_BYPASS=true` (or `1`)
 * in the environment to short-circuit `applyRateLimit`. Used by
 * `tests/setup.ts` so the vast majority of unit tests never have to think
 * about rate-limiting.
 *
 * The check is intentionally strict — only the canonical `'true'` / `'1'`
 * enable the bypass. Plausible-but-non-canonical strings (`'yes'`, `'on'`,
 * `'TRUE'`) are treated as off, so a stray uppercase or shell-quoting
 * accident in a CI config can't accidentally disable rate limiting.
 *
 * The first call in production logs an error if the bypass is somehow
 * enabled (see {@link warnIfBypassActiveInProduction}).
 */
function isBypassEnabled(): boolean {
  const raw = process.env.RATE_LIMIT_BYPASS;
  const enabled = raw === 'true' || raw === '1';
  if (enabled) warnIfBypassActiveInProduction();
  return enabled;
}

/**
 * Production safeguard. If `RATE_LIMIT_BYPASS` is on while `NODE_ENV` is
 * `'production'`, log an error EVERY TIME the dispatcher would have run —
 * this is a misconfiguration that disables a critical security control, and
 * the only way an operator finds out is via the log stream. Logging once is
 * not enough because production deploys often have multiple workers; one
 * error per worker per request guarantees visibility without flooding (in
 * the correctly-configured case the warning never fires).
 *
 * We do NOT throw or refuse to serve traffic: a hard fail would turn a
 * config mistake into an outage, which is worse than running with bypass.
 * The structured log is the alerting hook.
 */
function warnIfBypassActiveInProduction(): void {
  if (process.env.NODE_ENV !== 'production') return;
  logger.error('RATE_LIMIT_BYPASS=true is set in production — rate limiting is disabled', {
    nodeEnv: process.env.NODE_ENV,
    fix: 'Unset RATE_LIMIT_BYPASS in the production environment.',
  });
}

/**
 * Who is calling: the bucket identifier for the rule's key strategy, and the
 * org the caller acts for when the org request cap should count it.
 */
interface Caller {
  id: string;
  /**
   * Set only at `multi`, and only from a verified principal: for a session,
   * the org the guard will enter (the fork's tenant resolver, else the
   * session's `activeOrgId`); for a key, the org column of the row the lookup
   * found. Never the `x-sunrise-org` header — this runs before the proxy
   * strips and rewrites it, so here it is whatever the client sent.
   */
  orgId: string | null;
  /** Whose membership of `orgId` must be verified before counting; see `checkOrgRequestCap`. */
  memberUserId: string | null;
}

async function resolveCaller(key: RateLimitRule['key'], request: NextRequest): Promise<Caller> {
  const caller = await resolveIdentifier(key, request);
  return isMultiTenant() ? caller : { ...caller, orgId: null, memberUserId: null };
}

/**
 * Resolve the per-request identifier for the chosen key strategy.
 *
 * - `'ip'` returns the client IP.
 * - `'session-user'` resolves the better-auth session and returns the user
 *   ID. Falls back to `ip:${IP}` if no session (typical for routes the
 *   user hasn't authenticated to yet — they still get a per-IP bucket so
 *   anonymous traffic can't grief authenticated buckets).
 * - `'api-key'` looks up the key in `Authorization: Bearer <key>` and returns
 *   the stored key's id. Falls back to `ip:${IP}` when the header is missing
 *   or names no live key.
 * - `'embed-token'` looks up the `X-Embed-Token` token and returns its stored
 *   id combined with the IP (one bucket per visitor of an embedding site).
 *   Falls back to `ip:${IP}` when the header is missing or names no live token.
 *
 * The two credential strategies never key on the header as presented: the
 * caller chooses that value, so it would give them a fresh bucket per request
 * (#701). See `lib/security/rate-limit-credentials.ts` for what a lookup
 * costs and when it falls back to the IP.
 *
 * IP fallback exists because rate-limiting is best-effort defense in depth —
 * if we can't identify the caller more precisely, we still want *some* bucket
 * rather than letting the request through unlimited.
 *
 * Alongside the identifier, each built-in strategy that found a principal
 * names the org it acts for: the session's org, or the org column of the API
 * or MCP key row. An embed token, an IP, a fallback and a custom resolver name
 * none.
 */
async function resolveIdentifier(key: RateLimitRule['key'], request: NextRequest): Promise<Caller> {
  const ip = getClientIP(request);
  const noOrg = (id: string): Caller => ({ id, orgId: null, memberUserId: null });

  // App-defined key strategies (registerRateLimitKeyResolver). The rule
  // registry guarantees a rule naming a custom key had a resolver at
  // registration, so the unknown-key branch is defence in depth (a resolver
  // reset in tests, or a future ordering bug) — it logs loudly and falls back
  // to a per-IP bucket rather than failing open with no cap at all. A
  // resolver that throws gets the same treatment: rate limiting is
  // best-effort protection, and a fork bug in a resolver must not take the
  // whole API surface down with it — but it must not be silent either.
  if (!isBuiltInRateLimitKey(key)) {
    const resolver = resolveAppRateLimitKeyResolver(key);
    if (!resolver) {
      logger.error('rate-limit middleware: no resolver registered for custom key', {
        key,
        fix: 'registerRateLimitKeyResolver() must run before rules using the key are evaluated.',
      });
      return noOrg(`ip:${ip}`);
    }
    try {
      const id = await resolver(request);
      // A custom resolver answers a bucket, not an org: the org counter runs
      // only for the built-in strategies, which identify a principal.
      if (id) return noOrg(id);
    } catch (error) {
      logger.error('rate-limit middleware: custom key resolver threw; falling back to IP', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return noOrg(`ip:${ip}`);
  }

  switch (key) {
    case 'ip':
      return noOrg(ip);

    case 'session-user': {
      try {
        const session = await auth.api.getSession({ headers: request.headers });
        if (session?.user?.id) {
          const id = `user:${session.user.id}`;
          // `withAuth` reads a user API key before the cookie, so a request
          // carrying both acts for the key's org.
          const key = await userKeyOrg(request, ip);
          if (key) return { id, ...key };
          // Otherwise the org the guard will enter, in its precedence: the
          // fork's resolver (pure, computed from the request here rather than
          // read from a header the client could have set), else the
          // session's choice. Neither is a membership; the org counter
          // verifies it.
          return {
            id,
            orgId: isMultiTenant()
              ? sessionActingOrgId(resolveTenantFromRequest(request), session.session?.activeOrgId)
              : null,
            memberUserId: session.user.id,
          };
        }
      } catch {
        // Session resolution failed (auth provider hiccup, DB down). Fall
        // back to IP so we still apply some cap instead of failing open.
      }
      // No session: the per-IP bucket, as always — re-keying the catch-all
      // rule is not the org counter's business — and, for a user API key, the
      // key's org. Every `withAuth` route accepts one, so without this a
      // tenant's keys on the general API would never count against its cap.
      const key = await userKeyOrg(request, ip);
      return key ? { id: `ip:${ip}`, ...key } : noOrg(`ip:${ip}`);
    }

    case 'api-key': {
      const bearer = bearerOf(request);
      if (!bearer) return noOrg(`ip:${ip}`);
      const found = await resolveRateLimitCredential('api-key', bearer, ip);
      return found
        ? { id: `key:${found.id}`, orgId: found.orgId, memberUserId: found.memberUserId }
        : noOrg(`ip:${ip}`);
    }

    case 'embed-token': {
      const token = request.headers.get('x-embed-token');
      if (!token) return noOrg(`ip:${ip}`);
      const found = await resolveRateLimitCredential('embed-token', token, ip);
      // No org: an embed token is public (it sits in the embedding page), so
      // counting its traffic against the org's cap would let anyone hold the
      // tenant at its cap and lock its members out.
      return found ? noOrg(`embed:${found.id}:${ip}`) : noOrg(`ip:${ip}`);
    }
  }
}

/**
 * The `Authorization: Bearer` value, parsed exactly as the routes parse it
 * (`resolveApiKey`, the MCP transport): a case-sensitive `Bearer ` and the
 * rest verbatim, so the proxy never credits a header the route would refuse.
 */
function bearerOf(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/**
 * On a `session-user` route, the org of the user API key the request carries
 * — the credential `withAuth` reads first (`resolveApiKey`) — or `null` when
 * there is none, it names no live key, or the install is at `single`. Only an
 * `sk_` key: an MCP key is refused by those routes, so its requests must not
 * spend the org's capacity.
 */
async function userKeyOrg(
  request: NextRequest,
  ip: string
): Promise<Pick<Caller, 'orgId' | 'memberUserId'> | null> {
  if (!isMultiTenant()) return null;
  const bearer = bearerOf(request);
  if (!bearer.startsWith(API_KEY_PREFIX)) return null;
  const found = await resolveRateLimitCredential('api-key', bearer, ip);
  return found ? { orgId: found.orgId, memberUserId: found.memberUserId } : null;
}
