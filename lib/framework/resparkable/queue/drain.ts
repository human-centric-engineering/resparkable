/**
 * The drain: claim due jobs, run them, settle them, repeat until the budget is
 * spent or the queue is empty.
 *
 * ## Why this is a function rather than a daemon
 *
 * `drainResparkableJobs` takes a budget and returns. It is called from exactly
 * two places, and they run the same code:
 *
 * | Caller                                     | Budget                          |
 * | ------------------------------------------ | ------------------------------- |
 * | `registerAppJob`, on the 60s tick          | small — a few jobs, ~20 seconds |
 * | `npm run framework:resparkable:worker`, in a loop    | large — until the queue is empty |
 *
 * That is what keeps the module installable by checklist. A fork running
 * Resparkable for a team of thirty runs no extra process and is correct; a fork
 * at 100k users runs six worker containers and changes no code. Deployment
 * topology becomes the operator's choice rather than the module's requirement,
 * which is the answer to the obvious objection that owning a dispatcher forces
 * a second process on everybody.
 *
 * Correctness does not depend on which caller is running, because the lease
 * lives in the database. `registerAppJob` keeps last-run times in process
 * memory and gives no cluster-wide guarantee at all — every job registered
 * there has to be safe to run N times per interval. This one is, not because it
 * is idempotent, but because two ticks racing claim disjoint batches (see
 * `repo/jobs.ts` on `SKIP LOCKED`).
 *
 * ## The demand gate runs BEFORE the work, not after
 *
 * `phase-56-plan.md` §7 describes the gate as something a job asks "on
 * completion". Written that way it costs one worthless run per dormant period
 * per brain — the run happens, discovers nothing had changed, and only *then*
 * defers the next one. At weekly backoff that is roughly four billed
 * do-nothing runs a month per idle brain, and it fails the phase's own
 * acceptance test that an idle brain consumes **zero** LLM calls across a
 * simulated month.
 *
 * So the gate is a pre-flight check here. Same question, same index, asked
 * before anything is spent rather than after:
 *
 * > Never debit a person's balance for a run that cannot produce anything.
 *
 * A nightly triage over an inbox with nothing new in it reads the same notes,
 * calls the same model, writes the same "nothing to process" summary and
 * charges for it. That is not a cheap run, it is a worthless one, and it is a
 * charge the person would not agree to if they were asked. Asking first is the
 * only version of the rule that actually holds.
 */

import { randomUUID } from 'node:crypto';

import {
  nextDueAt,
  RESPARKABLE_JOB_SPECS,
  isResparkableJobKind,
  type ResparkableJobKind,
} from '@/lib/framework/resparkable/queue/kinds';
import { runResparkableJob, type JobRunOutcome } from '@/lib/framework/resparkable/queue/handlers';
import {
  claimResparkableJobs,
  completeResparkableJob,
  failResparkableJob,
  type ClaimedResparkableJob,
} from '@/lib/framework/resparkable/repo/jobs';
import { hasResparkableActivitySince } from '@/lib/framework/resparkable/repo/jobs';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { hasPositiveBalance } from '@/lib/framework/resparkable/services/billing';
import { logger } from '@/lib/logging';

/**
 * How long a worker holds a claimed row.
 *
 * Long enough that a slow reindex over a large brain finishes inside it, short
 * enough that a container killed mid-job does not park the row for an hour. The
 * lease is what makes reclaim a property of the clock rather than of a reaper
 * deciding what "stuck" means — `leaseExpiresAt < now()` is the whole rule.
 */
const LEASE_MS = 10 * 60_000;

/**
 * Consecutive failures before a job is put to sleep instead of retried.
 *
 * With the doubling backoff below, eight attempts spans about four hours of
 * retrying. Past that the failure is not transient and continuing to retry it
 * costs money on every attempt for a run that has never once succeeded — so the
 * row goes dormant, which slows it to weekly rather than stopping it. Never
 * deleted, because a deleted row is one that never comes back when whatever
 * broke is fixed.
 */
const MAX_ATTEMPTS = 8;

/** First retry gap. Doubles per attempt, so attempt 8 waits about two hours. */
const RETRY_BASE_MS = 60_000;

/** The slowest a dormant job is ever allowed to get. */
const DORMANT_CEILING_MS = 7 * 24 * 60 * 60_000;

export interface DrainBudget {
  /** Stop after this many jobs have been settled. */
  maxJobs?: number;
  /** Stop once this much wall-clock has elapsed, checked between batches. */
  maxWallClockMs?: number;
  /** How many jobs run at once, and therefore how many are claimed per batch. */
  concurrency?: number;
  /** Injected so the clock-sensitive tests mean something. */
  now?: Date;
  /** Overrides the generated worker identity. The standalone worker sets it. */
  workerId?: string;
}

export interface DrainResult {
  /**
   * Jobs claimed and settled — which is **not** the same as jobs that did any
   * work. A skipped run is a settled job: the row was claimed, gated, released
   * and rescheduled. `settled - skippedDormant - skippedNoCredit - failed` is
   * how many actually ran.
   *
   * Named for what it counts rather than for what a reader hopes it counts. The
   * obvious name for this field is `ran`, and `ran` sitting next to
   * `skippedDormant` in a log line reads as "four ran and two were skipped" —
   * six jobs, when there were four. That is a number somebody would use to
   * conclude the queue is keeping up.
   */
  settled: number;
  /** Of those, how many were skipped by the demand gate — no work, no charge. */
  skippedDormant: number;
  /** Skipped because the owner has no credits left to spend. */
  skippedNoCredit: number;
  /**
   * Deferred because this build has no handler for the row's `kind`.
   *
   * Counted apart from `skippedDormant` deliberately. Folding it in would
   * inflate "the demand gate skipped N" during a rolling deploy — hiding the
   * one condition an operator would actually want to see, behind the one they
   * expect to see all the time.
   */
  skippedUnknown: number;
  /** Jobs whose handler threw. */
  failed: number;
  /** True when a claim came back empty, i.e. nothing is due right now. */
  queueEmpty: boolean;
  outcome: JobRunOutcome;
}

const EMPTY_OUTCOME: JobRunOutcome = {
  executionsQueued: 0,
  connectionsCreated: 0,
  retentionArchived: 0,
  retentionPruned: 0,
  reindexEmbedded: 0,
  reindexChunks: 0,
  incomplete: false,
};

/**
 * Drain the queue within a budget.
 *
 * Never throws for a job-level failure. One brain's triage blowing up must not
 * cost the other forty-nine in the batch their turn, and must not stop the
 * loop: that is the same isolation the sweep rotation had, and losing it would
 * mean a single bad corpus wedges background work for everybody.
 */
export async function drainResparkableJobs(budget: DrainBudget = {}): Promise<DrainResult> {
  const maxJobs = budget.maxJobs ?? 10;
  const maxWallClockMs = budget.maxWallClockMs ?? 20_000;
  const concurrency = Math.max(1, budget.concurrency ?? 4);
  const workerId = budget.workerId ?? `tick-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  const result: DrainResult = {
    settled: 0,
    skippedDormant: 0,
    skippedNoCredit: 0,
    skippedUnknown: 0,
    failed: 0,
    queueEmpty: false,
    outcome: { ...EMPTY_OUTCOME },
  };

  while (result.settled < maxJobs && Date.now() - startedAt < maxWallClockMs) {
    // `now` is re-read per batch rather than taken once for the whole drain. A
    // worker loop can run for minutes, and claiming with a stale `now` would
    // step over rows that came due while the previous batch was running.
    const now = budget.now ?? new Date();
    const batchSize = Math.min(concurrency, maxJobs - result.settled);

    const batch = await claimResparkableJobs(workerId, batchSize, LEASE_MS, now);
    if (batch.length === 0) {
      result.queueEmpty = true;
      break;
    }

    // The claim already bounded the batch at `concurrency`, so the whole batch
    // runs at once and there is no second pool to tune. Settled with
    // `allSettled` rather than `all`: `settleOne` swallows its own job's
    // failure, and this is the belt for the case where the settle write itself
    // is what throws.
    const outcomes = await Promise.allSettled(batch.map((job) => settleOne(job, workerId, now)));

    for (const entry of outcomes) {
      result.settled++;
      if (entry.status === 'rejected') {
        result.failed++;
        logger.error('Resparkable job could not be settled', {
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
        continue;
      }
      applyOutcome(result, entry.value);
    }
  }

  return result;
}

type SettledJob =
  | { kind: 'ran'; outcome: JobRunOutcome }
  | { kind: 'dormant' }
  | { kind: 'no-credit' }
  | { kind: 'unknown-kind' }
  | { kind: 'failed' };

/**
 * Run and settle one claimed job.
 *
 * Every exit path writes the row exactly once, which is what stops a job being
 * left with a live lease after its worker has moved on. The one case that
 * deliberately does not is a settle whose `leasedBy` no longer matches — that
 * row belongs to somebody else now, and the zero-row update is the correct
 * outcome rather than an error.
 */
async function settleOne(
  job: ClaimedResparkableJob,
  workerId: string,
  now: Date
): Promise<SettledJob> {
  if (!isResparkableJobKind(job.kind)) {
    // A row written by a newer version than this process is running, or by
    // hand. Pushed a day out rather than failed, because burning through
    // `attempts` on a kind this build has never heard of would put the row to
    // sleep for a week over a rolling deploy.
    logger.warn('Resparkable job has an unknown kind — deferring', {
      jobId: job.id,
      kind: job.kind,
    });
    await completeResparkableJob(
      job.id,
      workerId,
      { dueAt: new Date(now.getTime() + 24 * 60 * 60_000), lastRunAt: null },
      now
    );
    return { kind: 'unknown-kind' };
  }

  const kind: ResparkableJobKind = job.kind;
  const spec = RESPARKABLE_JOB_SPECS[kind];
  const scope = spaceScope(job.userId);

  // ── Gate 1: has anything changed? ─────────────────────────────────────────
  //
  // `lastRunAt === null` means this job has never run, so there is no "since"
  // to compare against and the first run always happens. That matters for a
  // brand-new brain: it is empty and has no events, and gating it would mean
  // the first briefing never arrives.
  if (spec.demandGated && job.lastRunAt !== null) {
    const changed = await hasResparkableActivitySince(job.userId, job.lastRunAt);
    if (!changed) {
      const dormantSince = job.dormantSince ?? now;
      await completeResparkableJob(
        job.id,
        workerId,
        {
          dueAt: dormantDueAt(kind, job.timezone, now, dormantSince),
          // NOT stamped. `lastRunAt` means "when did this last actually run",
          // and moving it on a skip would make the next gate ask about a
          // shorter window than the one that has genuinely gone unexamined —
          // so a write made just before the skip would be missed for ever.
          lastRunAt: null,
          dormantSince,
        },
        now
      );
      return { kind: 'dormant' };
    }
  }

  // ── Gate 2: can this owner afford it? ─────────────────────────────────────
  //
  // Only for the kinds that queue a model run. Rescheduled at the normal
  // cadence rather than marked dormant: an owner at zero credits is not idle,
  // they are out of credit, and the moment they top up the next cycle should
  // find them. Queueing anyway would put a budget failure in their run history
  // at 03:15 for something they could not have fixed.
  if (spec.spendsCredits && !(await hasPositiveBalance(scope))) {
    // Logged, because `hasPositiveBalance` cannot tell "spent their credits"
    // from "never got a credit account". `ensureResparkableSpace` mints the
    // grant fire-and-forget, so a brain whose mint failed reads as a zero
    // balance for ever — and without this line it would lose all four
    // background workflows silently, with nothing anywhere naming the user.
    logger.info('Resparkable job skipped — no credit balance', {
      jobId: job.id,
      kind,
      userId: job.userId,
    });
    await completeResparkableJob(
      job.id,
      workerId,
      { dueAt: nextDueAt(kind, job.timezone, now), lastRunAt: null },
      now
    );
    return { kind: 'no-credit' };
  }

  try {
    const outcome = await runResparkableJob(kind, scope, now);
    await completeResparkableJob(
      job.id,
      workerId,
      { dueAt: nextDueAt(kind, job.timezone, now), lastRunAt: now, dormantSince: null },
      now
    );
    return { kind: 'ran', outcome };
  } catch (error) {
    const attempts = job.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);

    logger.error('Resparkable job failed', {
      jobId: job.id,
      kind,
      userId: job.userId,
      attempts,
      exhausted,
      error: message,
    });

    await failResparkableJob(
      job.id,
      workerId,
      {
        dueAt: exhausted
          ? new Date(now.getTime() + DORMANT_CEILING_MS)
          : new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempts - 1)),
        attempts,
        // Truncated because this column is read in a list view and an ORM stack
        // trace is not a diagnosis. The full error already went to the log line
        // above, with the job id to find it by.
        lastError: message.slice(0, 500),
        ...(exhausted ? { dormantSince: job.dormantSince ?? now } : {}),
      },
      now
    );
    return { kind: 'failed' };
  }
}

/**
 * How long a dormant job waits, and how its wall-clock kinds keep their hour.
 *
 * The wait is **however long the row has already been dormant**, floored at the
 * kind's normal cadence and capped at a week. That is a doubling backoff with
 * no counter column: quiet for three hours means re-checked in three hours,
 * quiet for three days means three days, quiet for a month means weekly. It
 * also means returning after a long absence costs one cycle rather than
 * thirteen, because any write clears `dormantSince` and the clock starts again
 * from the normal cadence.
 *
 * For a wall-clock kind the backoff is a *floor*, not a replacement. The next
 * due time is still 04:30 on somebody's clock — just the first 04:30 that falls
 * after the backoff has elapsed, so a dormant briefing arrives at breakfast
 * rather than at whatever hour the arithmetic happened to land on.
 */
function dormantDueAt(
  kind: ResparkableJobKind,
  timeZone: string,
  now: Date,
  dormantSince: Date
): Date {
  const elapsed = Math.max(0, now.getTime() - dormantSince.getTime());
  const notBefore = new Date(now.getTime() + Math.min(elapsed, DORMANT_CEILING_MS));

  // Interval kinds are answered directly rather than by walking the cadence.
  //
  // Walking looks harmless and silently caps the backoff at `steps × period`,
  // which for `reindex` at fifteen minutes is about ten hours however long the
  // brain has been quiet — so the documented weekly floor was unreachable for
  // the shortest-period kind, and an idle brain was polled 2.3 times a day
  // instead of once a week. At 100k brains that is seventeen times the
  // background load the design claims. A wall-clock kind has to keep its local
  // hour and so must walk; an interval kind has no hour to keep.
  if (RESPARKABLE_JOB_SPECS[kind].cadence.shape === 'interval') return notBefore;

  let candidate = nextDueAt(kind, timeZone, now);
  // Bounded rather than `while (true)`: a week's ceiling over a daily cadence
  // settles in seven steps and over a monthly one in a single step, so ten is
  // slack rather than a limit — and the guard means a cadence added later that
  // somehow fails to advance produces a late job rather than a hung worker.
  for (let step = 0; step < 10 && candidate < notBefore; step++) {
    candidate = nextDueAt(kind, timeZone, candidate);
  }
  return candidate;
}

function applyOutcome(result: DrainResult, settled: SettledJob): void {
  switch (settled.kind) {
    case 'dormant':
      result.skippedDormant++;
      return;
    case 'unknown-kind':
      result.skippedUnknown++;
      return;
    case 'no-credit':
      result.skippedNoCredit++;
      return;
    case 'failed':
      result.failed++;
      return;
    case 'ran': {
      const o = settled.outcome;
      result.outcome.executionsQueued += o.executionsQueued;
      result.outcome.connectionsCreated += o.connectionsCreated;
      result.outcome.retentionArchived += o.retentionArchived;
      result.outcome.retentionPruned += o.retentionPruned;
      result.outcome.reindexEmbedded += o.reindexEmbedded;
      result.outcome.reindexChunks += o.reindexChunks;
      result.outcome.incomplete = result.outcome.incomplete || o.incomplete;
    }
  }
}
