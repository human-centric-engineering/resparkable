/**
 * The job vocabulary: what kinds of background work exist, when each is next
 * owed, and which of them are allowed to cost anything.
 *
 * ## Why this file has no cron expressions in it
 *
 * `AiWorkflowSchedule` stores a cron string per row, which is why Resparkable
 * had to run a correction pass over every schedule it owned: fold a user's UTC
 * offset into a fixed expression and it is right only for the offset in force
 * when it was folded. Twice a year, for most of the world, every stored string
 * becomes an hour wrong — silently, in a job that runs before dawn, where the
 * only symptom is a briefing that arrives late.
 *
 * A `dueAt` cannot drift, because it is never carried forward. {@link nextDueAt}
 * runs at the moment the previous occurrence finishes and resolves the local
 * wall clock against the offset in force *then*. DST is handled by not having
 * anything to handle it with, which is the whole argument of `phase-56-plan.md`
 * §2 and the reason `schedules/cron.ts` and its drift-repair half no longer
 * exist.
 *
 * ## The two shapes of cadence
 *
 * **Wall-clock kinds** are calendar events: "03:15, their time". They are the
 * four that fire workflows plus retention, and their `dueAt` is the next
 * instant at which the owner's clock reads the target. Moving timezone changes
 * where the next one lands and nothing else.
 *
 * **Interval kinds** are continuous passes with no moment attached — the
 * connection sweep and the reindex drain. Nobody cares *when* a vector gets
 * compared, only that it eventually does, so they carry a period rather than a
 * time of day and never read a timezone at all. That is the same distinction
 * ask #1 argued upstream and won as `registerAppJob`, applied one level down.
 */

import {
  addZonedDays,
  addZonedMonths,
  instantAtWallClock,
  wallClockAt,
} from '@/lib/framework/resparkable/time/zoned';

/**
 * Every kind of per-user background work.
 *
 * Ordered as they are experienced rather than alphabetically: the four that
 * produce something a person reads, then the three that maintain the brain
 * underneath them.
 */
export const RESPARKABLE_JOB_KINDS = [
  'triage',
  'briefing',
  'weekly_review',
  'horizon_check',
  'sweep',
  'retention',
  'reindex',
] as const;

export type ResparkableJobKind = (typeof RESPARKABLE_JOB_KINDS)[number];

/** Narrow an untrusted string — a database column — to a known kind. */
export function isResparkableJobKind(value: string): value is ResparkableJobKind {
  return (RESPARKABLE_JOB_KINDS as readonly string[]).includes(value);
}

/** A time of day on the owner's own clock. */
interface LocalTime {
  hour: number;
  minute: number;
}

type Cadence =
  | { shape: 'daily'; local: LocalTime }
  /** `weekday` is 0-6 with Sunday at 0, matching `Date.getUTCDay()`. */
  | { shape: 'weekly'; local: LocalTime; weekday: number }
  | { shape: 'monthly'; local: LocalTime; dayOfMonth: number }
  | { shape: 'interval'; everyMs: number };

export interface JobKindSpec {
  cadence: Cadence;
  /**
   * Whether a run is allowed to be skipped when nothing has changed in the
   * brain since the last one.
   *
   * **This is a billing rule, not a budget lever**, and the distinction decides
   * which kinds carry it. Scheduled runs are debited against the owner's
   * `ResparkableCreditAccount`, so the platform is not the one eating the cost
   * of a pointless run — the person is. A nightly triage over an inbox with
   * nothing new in it reads the same notes, calls the same model, writes the
   * same "nothing to process" summary and charges for it. That is not a cheap
   * run, it is a worthless one, and it is a charge the person would not agree
   * to if they were asked.
   *
   * So: **never debit a balance for a run that cannot produce anything.**
   *
   * `retention` is the deliberate exception. It is driven by the calendar
   * rather than by activity — a 400-day-old event ages out of its window
   * whether or not the owner has touched anything since — so gating it on
   * "has something changed" would stop it working for exactly the dormant
   * brains whose data most needs ageing out. It also costs nothing but indexed
   * deletes, so there is no bill to protect anyone from.
   */
  demandGated: boolean;
  /**
   * Whether this kind queues an `AiWorkflowExecution` that will call a model.
   *
   * Used for the balance pre-check: an owner at zero credits gets the run
   * skipped and rescheduled rather than queued, because the alternative is an
   * execution that starts, fails on budget, and leaves a failure in their
   * history for something they could not have fixed at 03:15.
   */
  spendsCredits: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * When each kind is next owed, and what it is allowed to cost.
 *
 * The four wall-clock workflow times are carried over unchanged from the cron
 * era, deliberately: the queue is meant to change what pulls the trigger, not
 * when a person's briefing lands.
 */
export const RESPARKABLE_JOB_SPECS: Record<ResparkableJobKind, JobKindSpec> = {
  triage: {
    cadence: { shape: 'daily', local: { hour: 3, minute: 15 } },
    demandGated: true,
    spendsCredits: true,
  },
  briefing: {
    // 04:30 rather than chained off triage: the briefing selects "the top five
    // tasks", so triage has to have finished reprioritising first, and a
    // fifteen-minute gap is far easier to reason about than a cross-workflow
    // dependency. If triage overruns, the briefing writes from slightly staler
    // ranking rather than from nothing.
    cadence: { shape: 'daily', local: { hour: 4, minute: 30 } },
    demandGated: true,
    spendsCredits: true,
  },
  weekly_review: {
    // Friday at 16:00 — late enough that the week is done, early enough that it
    // is read before the weekend rather than on Monday.
    cadence: { shape: 'weekly', local: { hour: 16, minute: 0 }, weekday: 5 },
    demandGated: true,
    spendsCredits: true,
  },
  horizon_check: {
    // The 2nd is a fossil of the cron era, kept on purpose. `monthlyCron` could
    // not express "the 1st, shifted back a day" for the zones from +09:30 east,
    // so the 1st was unavailable. `dueAt` has no such problem and the 2nd is no
    // longer forced — but a monthly goals review is indifferent to which of the
    // first two days it lands on, and moving everyone's by a day for tidiness
    // is a change users would notice for no benefit they asked for.
    cadence: { shape: 'monthly', local: { hour: 9, minute: 0 }, dayOfMonth: 2 },
    demandGated: true,
    spendsCredits: true,
  },
  sweep: {
    // Free by construction: `sweepConnections` reads vectors that are already
    // stored and finds neighbour pairs in SQL, so a run costs indexed queries
    // and no embedding call. Still demand-gated, because a pass over a brain
    // nothing has been added to can only re-derive the pairs it derived last
    // time.
    cadence: { shape: 'interval', everyMs: 6 * HOUR },
    demandGated: true,
    spendsCredits: false,
  },
  retention: {
    // See `demandGated` above for why this one is not gated.
    cadence: { shape: 'daily', local: { hour: 2, minute: 0 } },
    demandGated: false,
    spendsCredits: false,
  },
  reindex: {
    // Fifteen minutes, and that is a *search freshness* number rather than a
    // cost one. Until this kind existed nothing drained `indexedHash` on a
    // schedule at all: capture nulled the column and the row sat unembedded
    // until somebody called `POST /resparkable/reindex` by hand, so a thought
    // captured on Tuesday was not findable by meaning on Wednesday. A quarter
    // of an hour is short enough that the gap stops being noticeable.
    //
    // Affordable at that cadence only because it is gated. `reindexPending`'s
    // hash comparison means a queued row costs a comparison rather than an
    // embedding call, and a brain with nothing queued costs six indexed counts
    // — which is still six queries every fifteen minutes across the whole
    // fleet, so an idle brain stops being polled at all and comes back the
    // moment anything is written to it.
    cadence: { shape: 'interval', everyMs: 15 * MINUTE },
    demandGated: true,
    spendsCredits: false,
  },
};

/**
 * The next moment this kind is owed, strictly after `from`.
 *
 * Wall-clock kinds resolve against `timeZone`'s offset **as it stands at the
 * instant this is called**, which is what makes the result immune to DST: there
 * is no stored expression to become stale, because the answer is recomputed
 * from scratch every time a job completes.
 *
 * Interval kinds ignore `timeZone` entirely. Passing one is harmless and keeps
 * every caller on the same signature.
 */
export function nextDueAt(kind: ResparkableJobKind, timeZone: string, from: Date): Date {
  const { cadence } = RESPARKABLE_JOB_SPECS[kind];

  if (cadence.shape === 'interval') {
    return new Date(from.getTime() + cadence.everyMs);
  }

  const todaysOccurrence = (at: Date): Date => {
    const wall = wallClockAt(at, timeZone);
    return instantAtWallClock(
      { ...wall, hour: cadence.local.hour, minute: cadence.local.minute, second: 0 },
      timeZone
    );
  };

  if (cadence.shape === 'daily') {
    const today = todaysOccurrence(from);
    return today > from ? today : todaysOccurrence(addZonedDays(from, 1, timeZone));
  }

  if (cadence.shape === 'weekly') {
    // Walk forward a local day at a time rather than doing modular arithmetic on
    // the weekday. Eight iterations at most, and it cannot get the day wrong
    // across a month or year boundary the way an offset calculation can.
    let cursor = from;
    for (let step = 0; step <= 8; step++) {
      const candidate = todaysOccurrence(cursor);
      if (candidate > from && localWeekday(candidate, timeZone) === cadence.weekday) {
        return candidate;
      }
      cursor = addZonedDays(cursor, 1, timeZone);
    }
    // Unreachable: a target weekday recurs within seven days by definition. A
    // throw rather than a silent fallback, because a job with no next due time
    // is one that stops for ever, and that must not be inferable from a green log.
    throw new Error(`nextDueAt: no ${kind} occurrence within 8 days in ${timeZone}`);
  }

  // Monthly. `addZonedMonths` clamps a day that does not exist in the target
  // month (31 → 30 / 28), which cannot bite here — every `dayOfMonth` in this
  // file is in the first week — but is the reason a month is added rather than
  // 30 days.
  const onDay = (at: Date): Date => {
    const wall = wallClockAt(at, timeZone);
    return instantAtWallClock(
      {
        ...wall,
        day: cadence.dayOfMonth,
        hour: cadence.local.hour,
        minute: cadence.local.minute,
        second: 0,
      },
      timeZone
    );
  };

  const thisMonth = onDay(from);
  return thisMonth > from
    ? thisMonth
    : onDay(addZonedMonths(startOfLocalMonth(from, timeZone), 1, timeZone));
}

/** 0-6 with Sunday at 0, read from the owner's clock rather than the server's. */
function localWeekday(instant: Date, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/**
 * Midnight on the 1st of the local month.
 *
 * `addZonedMonths` is applied to *this* rather than to `from`, so that adding a
 * month to the 31st cannot clamp into the wrong month before the day is
 * overwritten. Adding a month to the 1st is unambiguous in every calendar.
 */
function startOfLocalMonth(instant: Date, timeZone: string): Date {
  const wall = wallClockAt(instant, timeZone);
  return instantAtWallClock({ ...wall, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
}
