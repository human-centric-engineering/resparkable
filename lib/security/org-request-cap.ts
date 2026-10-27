/**
 * Per-org request cap (§110 t-789).
 *
 * Every rule in the rate-limit policy is keyed by the caller: an IP, a user,
 * an API key or an embed token. At `multi` that leaves an org with many users
 * or keys free to use as much shared capacity as all of them together, and
 * the operator with no single number to cap a tenant with. An org's
 * `Org.settings.quotas.requestsPerMinute` is that number, and
 * {@link checkOrgRequestCap} is the counter `applyRateLimit` runs **on top
 * of** the matched rule: both must pass, so per-caller fairness inside the
 * org stays as it was.
 *
 * **Outside the key registry on purpose.** The documented fork recipe used to
 * register a custom `'org'` key resolver, and `registerRateLimitKeyResolver`
 * rejects built-in key names, so claiming `'org'` as one would fail every fork
 * that followed it at boot. This is a second counter, not a key strategy.
 *
 * **The caps are cached** for {@link ORG_REQUEST_CAP_TTL_MS}, an org with no
 * cap included, so a request makes no database read while its org's entry is
 * warm. `PATCH /api/v1/admin/orgs/[id]` clears the entry with
 * {@link forgetOrgRequestCap}. The cache is held on `globalThis` because that
 * route runs in the server bundle and this counter in the proxy's, and a
 * module-level map would give each its own copy; within one process the route
 * then reaches the copy the proxy reads. Another instance sees the change when
 * its entry expires, so it can enforce the old cap for up to one TTL.
 *
 * **A user is counted only against an org they can enter.** A session or a
 * user API key names an org by a column the user cannot forge, but that
 * column outlives a membership: a removed member's session still names the
 * org. So the membership is verified — present, org `ACTIVE`, the guards'
 * rule — and cached for 30 seconds, and only for an org that has a cap, so an
 * uncapped org costs no read.
 *
 * **The counters are per process**, like every section tier. An install
 * running N instances behind a load balancer lets an org through up to N
 * times its cap. Each window is a sliding estimate from two one-minute counts
 * (see {@link OrgWindow}), so a burst at a minute's boundary is weighed, not
 * forgotten.
 *
 * Tenancy posture: row-keyed — the cap cache, the windows and the membership
 * cache are keyed by org id (and user id), filled by reads filtered on those
 * ids (lib/tenancy/process-state.ts).
 */

import { LRUCache } from 'lru-cache';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { RateLimitResult } from '@/lib/security/rate-limit';
import { SECURITY_CONSTANTS } from '@/lib/security/constants';
import { loadOrgQuotas } from '@/lib/tenancy/org-settings';
import { verifiedMembership } from '@/lib/tenancy/entry';

/** How long an org's request cap is served from the cache. */
export const ORG_REQUEST_CAP_TTL_MS = 30_000;

/** How long a verified (or refused) membership is served from the cache. */
const MEMBERSHIP_TTL_MS = 30_000;

/**
 * Upper bound on cached caps, memberships and org windows (per process). An
 * evicted window starts again at zero, so past this many capped orgs active
 * in one process, the least recent can briefly get a fresh cap's worth.
 */
const MAX_ENTRIES = 10_000;

/** A cached cap: the lookup, so concurrent misses share one read. */
interface CapEntry {
  cachedAt: number;
  value: Promise<number | null>;
}

const globalForOrgCaps = globalThis as unknown as {
  sunriseOrgRequestCapCache?: LRUCache<string, CapEntry>;
};

// Bounded, because the org a session names can come from a fork's resolver,
// which may answer an org id per hostname whether or not the org exists.
const capEntries: LRUCache<string, CapEntry> = (globalForOrgCaps.sunriseOrgRequestCapCache ??=
  new LRUCache<string, CapEntry>({ max: MAX_ENTRIES }));

// Whether a user may enter an org: a present membership in an ACTIVE org, the
// guards' rule. Keyed `userId:orgId`; the lookup is cached, so concurrent
// misses share one read.
const memberships = new LRUCache<string, Promise<boolean>>({
  max: MAX_ENTRIES,
  ttl: MEMBERSHIP_TTL_MS,
});

/**
 * One org's window: this minute's count and the last minute's. The two are
 * blended into a sliding estimate, so a check is constant work whatever the
 * cap — a list of timestamps would be scanned on every request, and caps run
 * to the tens of thousands.
 */
interface OrgWindow {
  start: number;
  count: number;
  previous: number;
}

const windows = new LRUCache<string, OrgWindow>({ max: MAX_ENTRIES });

/**
 * The org's `quotas.requestsPerMinute`, cached; `null` when it has none. A
 * failed read is dropped rather than kept as an answer.
 */
function orgRequestCap(orgId: string): Promise<number | null> {
  const current = capEntries.get(orgId);
  if (current && Date.now() - current.cachedAt < ORG_REQUEST_CAP_TTL_MS) return current.value;
  const entry: CapEntry = {
    cachedAt: Date.now(),
    value: loadOrgQuotas(orgId).then((quotas) => quotas.requestsPerMinute ?? null),
  };
  capEntries.set(orgId, entry);
  entry.value.catch(() => {
    if (capEntries.get(orgId) === entry) capEntries.delete(orgId);
  });
  return entry.value;
}

/** Whether `userId` may enter `orgId`, cached. A failed read is not kept. */
function isMember(userId: string, orgId: string): Promise<boolean> {
  const key = `${userId}:${orgId}`;
  const cached = memberships.get(key);
  if (cached) return cached;
  const value = verifiedMembership(userId, orgId, prisma).then((m) => !('refused' in m));
  memberships.set(key, value);
  value.catch(() => {
    if (memberships.get(key) === value) memberships.delete(key);
  });
  return value;
}

/** Count one request in the org's window, if the cap leaves room for it. */
function countRequest(orgId: string, cap: number): RateLimitResult {
  const interval = SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL;
  const now = Date.now();
  const start = now - (now % interval);
  let window = windows.get(orgId);
  if (!window || window.start !== start) {
    const previous = window?.start === start - interval ? window.count : 0;
    window = { start, count: 0, previous };
  }
  const used = window.previous * (1 - (now - start) / interval) + window.count;
  const success = used < cap;
  if (success) window.count += 1;
  windows.set(orgId, window);
  return {
    success,
    limit: cap,
    remaining: Math.max(0, Math.floor(cap - used - (success ? 1 : 0))),
    reset: Math.ceil(roomAt(window, cap, interval) / 1000),
  };
}

/**
 * When the estimate next drops below the cap, for `Retry-After` — not the end
 * of the minute, when the minute just gone still weighs in full and a client
 * retrying then is refused again. This minute's count alone at or over the cap
 * frees as it decays through the next one; otherwise the last minute's
 * decays through this one.
 */
function roomAt(window: OrgWindow, cap: number, interval: number): number {
  if (window.count >= cap) {
    return window.start + interval + interval * (1 - cap / window.count);
  }
  if (window.previous === 0) return Date.now();
  return window.start + interval * (1 - (cap - window.count) / window.previous);
}

/**
 * Count one request against its org's cap.
 *
 * @param orgId The org a verified principal acts for — never one a client
 *   header named.
 * @param memberUserId The user whose membership the org rests on (a session's
 *   user, or a user API key's owner), or `null` for a credential with no user
 *   behind it, whose org its own lookup already checked. A user who cannot
 *   enter the org — removed from it, or the org suspended — is not counted
 *   against it: their requests are refused by the guard anyway, and counting
 *   them would let a former member hold an org at its cap.
 * @returns the window's answer, or `null` when nothing was counted: the org
 *   has no cap, or the user cannot enter it. A cap or membership that cannot
 *   be read is also `null`, logged: the org counter is defence in depth over
 *   the per-caller limits, which still applied, and a database fault must not
 *   refuse every request.
 */
export async function checkOrgRequestCap(
  orgId: string,
  memberUserId: string | null
): Promise<RateLimitResult | null> {
  try {
    const cap = await orgRequestCap(orgId);
    if (cap === null) return null;
    if (memberUserId && !(await isMember(memberUserId, orgId))) return null;
    return countRequest(orgId, cap);
  } catch (error) {
    logger.warn('rate-limit middleware: could not read the org request cap; not applied', {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Drop one org's cached cap after a write, so this process enforces the new one at once. */
export function forgetOrgRequestCap(orgId: string): void {
  capEntries.delete(orgId);
}

/** Test-only: drop every cached cap and membership, and every org's window. */
export function resetOrgRequestCaps(): void {
  capEntries.clear();
  memberships.clear();
  windows.clear();
}
