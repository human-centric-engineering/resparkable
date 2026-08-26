/**
 * `ResparkableSpace` — the satellite row every other Resparkable table hangs off (D1).
 *
 * One row per user, carrying the settings that are genuinely per-person:
 * timezone (snooze presets and retention windows resolve there, never in server
 * time), scorer weights, retention windows, work style, and the inbox token
 * that routes captured email.
 *
 * **Everything else in the brain requires this row to exist**, because the
 * hand-written FK cascade (probe B1) runs `user → space → everything`. So
 * `ensureResparkableSpace()` is called at the top of any flow that can be a user's
 * first interaction — first page load, first capture, first agent turn — rather
 * than at signup. Resparkable has no fork-owned hook at user creation (upstream
 * #464), and hanging the brain off one would in any case leave every user who
 * predates the install without a space.
 */

import { randomBytes } from 'node:crypto';

import { applyLedgerEntry, ensureCreditAccount } from '@/lib/framework/resparkable/repo/billing';
import { findResparkableBillingSettings } from '@/lib/framework/resparkable/repo/billing-settings';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  createSpace,
  findSpaceByToken,
  findSpaceByUserId,
  updateSpaceSettings,
} from '@/lib/framework/resparkable/repo/space';
import {
  resolveBillingSettings,
  resolveEnergyProfile,
  resolvePriorityWeights,
  resolveRetentionPolicy,
} from '@/lib/framework/resparkable/settings';
import type {
  EnergyProfile,
  PriorityWeights,
  RetentionPolicy,
  UpdateSpaceInput,
} from '@/lib/framework/resparkable/validations';
import { STRENGTH_FLOOR } from '@/lib/framework/resparkable/search/connections';
import { ensureResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';
import { logger } from '@/lib/logging';
import type { ResparkableSpace } from '@prisma/client';

/**
 * 16 bytes of hex. This lands in an email address
 * (`brain+<inboxToken>@<RESPARKABLE_INBOX_DOMAIN>`), so anyone who learns it can
 * inject thoughts into that user's brain — it is a bearer credential and is
 * sized accordingly (§17 risk 8). Hex rather than base64url because it has to
 * survive mail systems that lowercase the local part.
 */
const INBOX_TOKEN_BYTES = 16;

function generateInboxToken(): string {
  return randomBytes(INBOX_TOKEN_BYTES).toString('hex');
}

/**
 * Get the caller's space, creating it on first use.
 *
 * Idempotent and safe under concurrency: two parallel first-requests race on
 * `userId @unique`, the loser catches the constraint violation and re-reads.
 * That is deliberate rather than a transaction — the create is a single
 * statement and the read-after-conflict is the cheapest correct resolution.
 *
 * @param userId - **Always** from the verified session or `CapabilityContext`,
 *   never from a request body or an LLM-supplied argument (D5, §17 risk 6d).
 */
export async function ensureResparkableSpace(userId: string): Promise<ResparkableSpace> {
  if (!userId) {
    throw new Error('ensureResparkableSpace: userId is required');
  }

  const existing = await findSpaceByUserId(userId);
  if (existing) return existing;

  try {
    const created = await createSpace({ userId, inboxToken: generateInboxToken() });

    // Defaults for timezone, weights and retention live in code, not in this
    // row — a new scorer factor or retention window must not need a backfill.
    logger.info('Resparkable space created', { userId, spaceId: created.id });

    // A user's background work starts the moment their brain exists: seven
    // rows in `framework_resparkable_job`, one per kind, each with a `dueAt`
    // computed from the timezone this row was just created with.
    //
    // Never allowed to fail the create. This runs on the read path of a
    // brand-new brain, and a first page load must not 500 because the queue
    // table was briefly unavailable. `ensureResparkableJobs` swallows its own
    // failure for that reason, and the drain's backfill net picks up any brain
    // that ends up with no rows (`queue/enqueue.ts`).
    //
    // Deliberately not called on the `existing` branch above, which is the hot
    // read path under capture, chat and every resource service. Before phase 56
    // this call site had a twin there in spirit — the sweep rotation re-ran the
    // schedule pass over every brain to correct DST drift — and the whole point
    // of storing `dueAt` rather than a cron string is that there is no longer
    // any drift to correct, so there is nothing for a repeat pass to do.
    await ensureResparkableJobs(userId, created.timezone);

    // Phase 29: billing. Same fire-and-forget shape as the schedules call
    // above and for the same reason: this is the read path of a brand-new
    // brain and must not 500 because billing setup was briefly unavailable.
    // Unlike schedules, a missed grant here is not silently corrected later:
    // `assertPositiveBalance`'s lazy backfill creates the account at zero
    // balance with no retroactive grant (that grant is specifically for
    // genuinely new users, i.e. this branch). So this failing means a new
    // user starts at zero instead of their configured grant, worse than a
    // missed schedule correction, but still better than blocking their first
    // page load on it.
    await ensureNewUserCreditGrant(userId).catch((error: unknown) => {
      logger.warn('Resparkable credit account could not be created for a new space', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return created;
  } catch (error) {
    // Lost the race — the other request created it. Any other failure rethrows.
    if (isUniqueConstraintViolation(error)) {
      const raced = await findSpaceByUserId(userId);
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Read the space without creating one. Use where absence is meaningful (an
 * admin view, a maintenance sweep that should skip users who never started).
 */
export async function getResparkableSpace(userId: string): Promise<ResparkableSpace | null> {
  if (!userId) return null;
  return findSpaceByUserId(userId);
}

/**
 * Resolve a space by its inbox token — the email-capture entry point.
 *
 * Returns null rather than throwing on an unknown token: the caller is an
 * inbound webhook handler, and an unrecognised address is a routine event
 * (bounce, stale forward), not an error condition.
 */
export async function findSpaceByInboxToken(inboxToken: string): Promise<ResparkableSpace | null> {
  if (!inboxToken) return null;
  return findSpaceByToken(inboxToken);
}

/**
 * The settings payload `GET /resparkable/space` returns.
 *
 * It carries the **effective** settings, not the raw columns: the three `Json`
 * columns are null until someone customises them, and a settings screen that
 * rendered nulls would show empty weight boxes and imply the scorer has no
 * opinion. Resolving here means the client sees what is actually in force, and
 * `customised` tells it which values are the user's own.
 *
 * `inboxToken` is deliberately **absent**. It is a bearer credential that routes
 * email into this brain (§17 risk 8), and a general settings read is exactly the
 * kind of response that ends up in a log, a cache or a bug report. It gets its
 * own endpoint when email capture lands in phase 9.
 */
export interface ResparkableSettings {
  timezone: string;
  workStyle: string;
  priorityWeights: PriorityWeights;
  energyProfile: EnergyProfile;
  retentionPolicy: RetentionPolicy;
  /**
   * The similarity a pair must clear to be proposed as a connection.
   *
   * Resolved, like the weights above: the column is nullable and the default lives
   * in code (`STRENGTH_FLOOR`), so a caller always sees the number actually in
   * force rather than a `null` it has to interpret.
   */
  connectionStrengthFloor: number;
  /** Which of the three Json columns hold the user's own values rather than defaults. */
  customised: { priorityWeights: boolean; energyProfile: boolean; retentionPolicy: boolean };
}

/**
 * Read the caller's settings, creating the space on first use.
 *
 * This is the natural "first page load" hook the plan asks for — a settings or
 * dashboard read is usually a new user's first authenticated request, and doing
 * the bootstrap here means their first write already has the space its FK needs.
 */
export async function getResparkableSettings(userId: string): Promise<ResparkableSettings> {
  return toSettings(await ensureResparkableSpace(userId));
}

/**
 * Apply a settings patch.
 *
 * Passing `null` for one of the `Json` columns resets it to the defaults, which
 * is a genuinely useful action ("put the weights back how they were") and needs
 * no separate endpoint. Omitting a key leaves it untouched.
 */
export async function updateResparkableSettings(
  userId: string,
  input: UpdateSpaceInput
): Promise<ResparkableSettings> {
  await ensureResparkableSpace(userId);

  // Strip `undefined` so an omitted key stays untouched rather than being
  // nulled. The assertion is sound and confined: only keys whose value is
  // `undefined` are removed, and a key can only hold `undefined` if it was
  // optional in `UpdateSpaceInput`, so the result still satisfies the type —
  // something `Object.fromEntries` cannot express. This is not an assertion on
  // external data (CLAUDE.md): `input` has already been through Zod. Mirrors
  // `definedOnly` in `services/resources.ts`.
  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as UpdateSpaceInput;

  const updated = await updateSpaceSettings(userId, data);

  logger.info('Resparkable settings updated', { userId, fields: Object.keys(data) });

  return toSettings(updated);
}

function toSettings(space: ResparkableSpace): ResparkableSettings {
  return {
    timezone: space.timezone,
    workStyle: space.workStyle,
    priorityWeights: resolvePriorityWeights(space.priorityWeights),
    energyProfile: resolveEnergyProfile(space.energyProfile),
    retentionPolicy: resolveRetentionPolicy(space.retentionPolicy),
    connectionStrengthFloor: space.connectionStrengthFloor ?? STRENGTH_FLOOR,
    customised: {
      priorityWeights: space.priorityWeights !== null,
      energyProfile: space.energyProfile !== null,
      retentionPolicy: space.retentionPolicy !== null,
    },
  };
}

/** Prisma's unique-constraint error code, without importing the runtime namespace. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/**
 * Create a new space's credit account and, if this deployment configures
 * one, its opening `admin_grant` ledger entry, kept as a real ledger row
 * rather than an unexplained starting balance, so every credit an account
 * ever holds traces back to one.
 */
async function ensureNewUserCreditGrant(userId: string): Promise<void> {
  const scope = ownerScope(userId);
  await ensureCreditAccount(scope, 0);

  const settings = resolveBillingSettings(await findResparkableBillingSettings());
  if (settings.newUserGrantCredits > 0) {
    await applyLedgerEntry(scope, {
      kind: 'admin_grant',
      creditsDelta: settings.newUserGrantCredits,
      note: 'New user grant',
    });
  }
}
