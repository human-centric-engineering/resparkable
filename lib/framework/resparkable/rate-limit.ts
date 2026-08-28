/**
 * Resparkable's rate-limit contribution — one call the host makes, not a body it
 * pastes.
 *
 * `lib/app/rate-limit.ts` is a **leaf-owned** file: the host project owns it, and
 * a host running Resparkable alongside its own rules must not have to merge
 * Resparkable's. So Resparkable exports a ready-made registrar and `install.md` asks for
 * one import and one call. When Resparkable adds a fifth expensive route, hosts get
 * it on upgrade without editing anything.
 *
 * ## Why these nine routes need their own caps at all
 *
 * `/api/v1/**` already inherits 100/min keyed on the session user from
 * `proxy.ts`, and CLAUDE.md is explicit that handlers must not call section
 * limiters themselves. Sub-caps are for flows where 100/min is the *wrong shape*
 * because a single request is expensive rather than cheap:
 *
 *   - **`/search`** embeds the query — one paid API call per request. 100/min is
 *     100 embedding calls a minute from one session.
 *   - **`/reindex`** can queue the entire corpus for re-embedding.
 *   - **`/documents`** parses and stores a file up to the upload ceiling.
 *   - **`/connections/sweep`** runs hundreds of vector queries.
 *   - **`/ideate`** makes a chat-completion call — the most expensive single
 *     request in the tier, and the only one whose cost is measured in cents
 *     rather than fractions of one.
 *   - **`/chat/stream`** holds an SSE connection open for a multi-step tool
 *     loop, and each turn is an LLM call plus whatever tools it decides to run.
 *   - **`/transcribe`** ships up to 25 MB of audio to a paid speech-to-text
 *     provider that bills per audio-minute.
 *   - **`/transcribe/image`** makes one vision-completion call per photo,
 *     billed per image rather than per token — same shape as `/transcribe`,
 *     registered ahead of it so the more specific path isn't shadowed.
 *   - **`/vault`** reads every table the brain has to build an export, and on
 *     import inflates an archive and plans thousands of row writes.
 *
 * None of these is a per-second interaction — a person searches a few times a
 * minute and reindexes once a week — so the caps are comfortably above real use
 * and well below what a loop could spend.
 *
 * Matchers are pinned to `/api/v1/resparkable/…` with anchored regexes.
 * `registerRateLimitRule` throws if a matcher could shadow a Resparkable-protected
 * surface, so a careless `/api/v1/` prefix fails at boot rather than quietly
 * capping the platform's own routes.
 */

import { createRateLimiter, registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Search: 30/min. Generous for a human typing queries, and a hard ceiling on
 * per-minute embedding spend from one session.
 */
const resparkableSearchLimiter = createRateLimiter({
  interval: MINUTE,
  maxRequests: 30,
  uniqueTokenPerInterval: 500,
});

/**
 * Reindex and sweep: 5/hour. Both are "kick off a batch job" verbs. Anyone
 * needing more than five a hour is debugging, and can use the smoke script.
 */
const resparkableBatchLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 5,
  uniqueTokenPerInterval: 500,
});

/**
 * Vault export and import: 10/hour.
 *
 * Both read every table the brain has, and an import additionally inflates and
 * plans an archive. A real session is one export, one dry run and one apply —
 * ten leaves room to iterate on a vault that needed fixing, and stops a stuck
 * client from re-reading the whole corpus in a loop.
 */
const resparkableVaultLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 10,
  uniqueTokenPerInterval: 500,
});

/** Uploads: 20/hour. Above a realistic import session, below a script. */
const resparkableUploadLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 20,
  uniqueTokenPerInterval: 500,
});

/**
 * Ideation: 10/hour.
 *
 * Tighter than everything above because it is the only flow that buys tokens per
 * request. Ten framings sessions an hour is well past what anyone does
 * deliberately — the shape this is guarding against is a UI bug or an agent loop
 * calling it in a tight cycle, where the bill, not the load, is the damage.
 */
const resparkableIdeateLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 10,
  uniqueTokenPerInterval: 500,
});

/**
 * Chat: 20/min.
 *
 * A per-minute cap rather than a per-hour one, because chat is genuinely
 * conversational — a long working session is a hundred turns, and an hourly cap
 * generous enough for that would be no cap at all for a loop. Twenty a minute is
 * three times faster than anyone types and holds the ceiling on a client bug
 * that re-sends on every render.
 *
 * The per-turn spend ceiling is separate and lives on the agent
 * (`maxCostPerTurnUsd` on `resparkable-companion`): this bounds how many turns, that
 * bounds how expensive one turn can get. Neither substitutes for the other.
 */
const resparkableChatLimiter = createRateLimiter({
  interval: MINUTE,
  maxRequests: 20,
  uniqueTokenPerInterval: 500,
});

/**
 * Voice capture: 10/min.
 *
 * Matches the platform's `audioLimiter` for the admin transcribe route, and for
 * the same reason: each request ships up to 25 MB to a paid provider and comes
 * back with a bill measured per audio-minute. Ten clips a minute is far past
 * dictating — you cannot speak that many — and well under what a stuck recorder
 * loop would send.
 */
const resparkableAudioLimiter = createRateLimiter({
  interval: MINUTE,
  maxRequests: 10,
  uniqueTokenPerInterval: 500,
});

/**
 * Image capture: 10/min.
 *
 * Same shape and same reasoning as voice: one non-streaming vision completion
 * per request, billed per image rather than per token (`operation: 'vision'`
 * in `lib/orchestration/llm/cost-tracker.ts`), so this is a per-call cost
 * ceiling, not a per-second one. Ten photographs a minute is far past what
 * anyone does by hand and well under what a stuck camera-retry loop would send.
 */
const resparkableImageLimiter = createRateLimiter({
  interval: MINUTE,
  maxRequests: 10,
  uniqueTokenPerInterval: 500,
});

/**
 * The public share reader: 60/hour per IP.
 *
 * The only unauthenticated surface in the tier, and the only one where the
 * interesting thing to do without a credential is **guess**. The token is 192
 * bits, so guessing is hopeless on the arithmetic alone — this is not what
 * stops an attacker, and it is not meant to be. What it stops is the cheap
 * version: a script pointed at `/s/` burning database lookups for free.
 *
 * Keyed on IP because there is nothing else to key on. That means a shared
 * office NAT shares a budget, which is why the cap is sixty rather than ten —
 * a genuine reader opens a link once or twice, and a roomful of them opening
 * the same roadmap still fits.
 */
const resparkablePublicLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 60,
  uniqueTokenPerInterval: 5000,
});

/**
 * Register Resparkable's tiers and rules.
 *
 * Idempotent: both registrars dedupe (by identical limiter instance and by rule
 * reference respectively), which matters because Next re-evaluates the middleware
 * module on every hot reload in dev.
 */
export function registerResparkableRateLimits(): void {
  registerRateLimitTier('resparkable-search', resparkableSearchLimiter);
  registerRateLimitTier('resparkable-batch', resparkableBatchLimiter);
  registerRateLimitTier('resparkable-upload', resparkableUploadLimiter);
  registerRateLimitTier('resparkable-ideate', resparkableIdeateLimiter);
  registerRateLimitTier('resparkable-chat', resparkableChatLimiter);
  registerRateLimitTier('resparkable-audio', resparkableAudioLimiter);
  registerRateLimitTier('resparkable-image', resparkableImageLimiter);
  registerRateLimitTier('resparkable-vault', resparkableVaultLimiter);
  registerRateLimitTier('resparkable-public', resparkablePublicLimiter);

  // Keyed on the session user, not the IP: this is authenticated, per-person
  // work, and IP keying would make one household share a search budget.
  // Keyed on IP, unlike everything else here: the public reader has no session
  // to key on. Registered first so it cannot be shadowed by a later prefix.
  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/public(?:\/|$)/,
    tier: 'resparkable-public',
    key: 'ip',
  });

  // The page, not the API. `/s/[token]` is a server component that calls the
  // service directly rather than fetching its own endpoint, so the API rule
  // above never fires for it — and the proxy runs on page requests too, so this
  // is where the cap actually lands for a browser.
  registerRateLimitRule({
    match: /^\/s\//,
    tier: 'resparkable-public',
    key: 'ip',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/search(?:\/|$)/,
    tier: 'resparkable-search',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/reindex(?:\/|$)/,
    tier: 'resparkable-batch',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/connections\/sweep(?:\/|$)/,
    tier: 'resparkable-batch',
    key: 'session-user',
  });

  // The prefix covers `/documents` and `/documents/extract` alike — one parses
  // and stores, the other parses and throws away, and the expensive half
  // (pulling text out of a PDF) is the same work in both.
  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/documents(?:\/|$)/,
    tier: 'resparkable-upload',
    key: 'session-user',
  });

  // Registered ahead of the `/transcribe` rule below: both matchers accept a
  // trailing `/…`, and the policy table's "first match wins" rule means the
  // more specific path — `/transcribe/image` — has to be listed first or every
  // image-capture request would silently land on the audio tier instead.
  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/transcribe\/image(?:\/|$)/,
    tier: 'resparkable-image',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/transcribe(?:\/|$)/,
    tier: 'resparkable-audio',
    key: 'session-user',
  });

  // The prefix covers `/vault/export` and `/vault/import` alike — both read the
  // whole brain, and the import additionally inflates and plans an archive.
  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/vault(?:\/|$)/,
    tier: 'resparkable-vault',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/ideate(?:\/|$)/,
    tier: 'resparkable-ideate',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/chat(?:\/|$)/,
    tier: 'resparkable-chat',
    key: 'session-user',
  });

  // Only the regenerate path, deliberately — `GET /resparkable/briefing` reads a
  // stored row and should stay as cheap as any other read. Regeneration queues a
  // workflow run that bills a model call, so it belongs on the same tier as
  // ideation: the two are the endpoints where a held-down button costs money.
  registerRateLimitRule({
    match: /^\/api\/v1\/resparkable\/briefing\/regenerate(?:\/|$)/,
    tier: 'resparkable-ideate',
    key: 'session-user',
  });
}
