/**
 * Unit Tests: `registerResparkableRateLimits`.
 *
 * These sub-caps sit on top of the 100/min section cap `/api/v1/**` already
 * inherits from `proxy.ts`, and they exist for flows where one request is
 * expensive rather than cheap. Two properties are worth holding, and neither is
 * visible from the app:
 *
 *   1. **Every matcher stays inside Resparkable's own namespace.**
 *      `registerRateLimitRule` throws if a matcher could shadow a
 *      Resparkable-protected surface, so a careless prefix fails at boot — but
 *      only if something actually calls the registrar. This test is that call.
 *      Two namespaces, since Release 2: `/api/v1/resparkable/` and `/s/`, the
 *      public share reader.
 *   2. **Every AUTHENTICATED rule is keyed on the session user, not the IP.**
 *      IP keying would make one household share a search budget. The two public
 *      share rules are the deliberate exception and are keyed on IP, because a
 *      reader holding a link has no session to key on.
 *
 * The registrar is also idempotent by necessity: Next re-evaluates the
 * middleware module on every hot reload in dev, so a registrar that appended on
 * each call would grow the policy table without bound.
 *
 * @see lib/framework/resparkable/rate-limit.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...actual, registerRateLimitTier: vi.fn() };
});

vi.mock('@/lib/security/rate-limit-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit-policy')>();
  return { ...actual, registerRateLimitRule: vi.fn() };
});

import { registerResparkableRateLimits } from '@/lib/framework/resparkable/rate-limit';
import { registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';

const mockedTier = vi.mocked(registerRateLimitTier);
const mockedRule = vi.mocked(registerRateLimitRule);

/** Every path the caps are meant to cover, and the tier each should land on. */
const EXPECTED: Array<{ path: string; tier: string }> = [
  { path: '/api/v1/resparkable/search', tier: 'resparkable-search' },
  { path: '/api/v1/resparkable/reindex', tier: 'resparkable-batch' },
  { path: '/api/v1/resparkable/connections/sweep', tier: 'resparkable-batch' },
  { path: '/api/v1/resparkable/documents', tier: 'resparkable-upload' },
  { path: '/api/v1/resparkable/ideate', tier: 'resparkable-ideate' },
  { path: '/api/v1/resparkable/transcribe', tier: 'resparkable-audio' },
  // The one that matters most: both this matcher and `/transcribe`'s own accept
  // a trailing path, so this only lands on the right tier if the image rule is
  // registered — and therefore evaluated — before the audio one.
  { path: '/api/v1/resparkable/transcribe/image', tier: 'resparkable-image' },
  // The public reader, both halves: the JSON endpoint and the page. The page is
  // a server component that calls the service directly rather than fetching its
  // own API, so the API rule never fires for a browser — without the `/s/` rule
  // the reader would be uncapped.
  { path: '/api/v1/resparkable/public/abc', tier: 'resparkable-public' },
  { path: '/s/abc', tier: 'resparkable-public' },
];

/** The paths whose rules are keyed on IP rather than the session. */
const IP_KEYED = ['/api/v1/resparkable/public/abc', '/s/abc'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerResparkableRateLimits', () => {
  it('registers a tier for each cap, including the ideate one', () => {
    registerResparkableRateLimits();

    const names = mockedTier.mock.calls.map((call) => call[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        'resparkable-search',
        'resparkable-batch',
        'resparkable-upload',
        'resparkable-ideate',
        'resparkable-audio',
        'resparkable-image',
        'resparkable-public',
      ])
    );
  });

  it('registers a rule for every capped path, on the right tier', () => {
    registerResparkableRateLimits();

    const rules = mockedRule.mock.calls.map((call) => call[0]);

    for (const { path, tier } of EXPECTED) {
      const rule = rules.find((candidate) =>
        candidate.match instanceof RegExp ? candidate.match.test(path) : false
      );
      expect(rule, `no rate-limit rule matches ${path}`).toBeDefined();
      expect(rule?.tier, `${path} landed on the wrong tier`).toBe(tier);
    }
  });

  it('keys the authenticated rules on the session user, and only the public ones on IP', () => {
    // IP keying would make one household share a search budget, so every
    // authenticated cap is per-person. The public share reader is the one place
    // there is no session to key on — a reader holding a link has no account —
    // and it is the one place the exception is allowed.
    registerResparkableRateLimits();

    for (const [rule] of mockedRule.mock.calls) {
      const isPublic = IP_KEYED.some((path) =>
        rule.match instanceof RegExp ? rule.match.test(path) : false
      );
      expect(rule.key, `${String(rule.match)} is keyed wrongly`).toBe(
        isPublic ? 'ip' : 'session-user'
      );
    }
  });

  it("scopes every matcher inside Resparkable's own namespaces", () => {
    // The registrar throws on a matcher that could shadow a Resparkable surface, but
    // only for the probes it knows about. Asserting the namespace directly means
    // a matcher that merely *could* widen is caught here rather than at boot.
    registerResparkableRateLimits();

    const foreignPaths = [
      '/api/v1/admin/orchestration/agents',
      '/api/v1/auth/sign-in',
      '/api/v1/chat/stream',
      '/api/v1/users/me',
      // The `/s/` rule is a short prefix on the site root, which is exactly the
      // shape that shadows things by accident. These are the near misses.
      '/settings',
      '/signup',
      '/search',
    ];

    for (const [rule] of mockedRule.mock.calls) {
      for (const path of foreignPaths) {
        const matches = rule.match instanceof RegExp ? rule.match.test(path) : false;
        expect(matches, `${String(rule.match)} must not match ${path}`).toBe(false);
      }
    }
  });

  it('does not cap the plain capture path — it is cheap and must stay fast', () => {
    // Capture is the front door and writes one row. Putting it behind a sub-cap
    // would make the product's core gesture fail under exactly the burst a
    // person produces when emptying their head.
    registerResparkableRateLimits();

    for (const [rule] of mockedRule.mock.calls) {
      const matches =
        rule.match instanceof RegExp ? rule.match.test('/api/v1/resparkable/capture') : false;
      expect(matches).toBe(false);
    }
  });
});
