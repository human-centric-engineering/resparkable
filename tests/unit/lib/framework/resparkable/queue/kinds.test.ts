/**
 * Unit Tests: the job cadence — `nextDueAt`.
 *
 * ## What this file is really guarding
 *
 * The whole argument for storing an instant rather than a cron expression is
 * that an instant cannot drift. `AiWorkflowSchedule` had no timezone column, so
 * Resparkable folded each user's UTC offset into a fixed expression — correct
 * for the offset in force when it was folded, and an hour wrong for half the
 * year afterwards. It needed a correction pass to survive, and the correction
 * pass needed the sweep rotation to reach every brain, and that is three moving
 * parts to compensate for one missing column.
 *
 * `nextDueAt` recomputes from scratch every time a job completes, against the
 * offset in force *then*. So the assertions that matter here are the ones about
 * DST: the local hour has to hold either side of a transition, with nothing
 * correcting anything.
 *
 * A note on the fixtures. Europe/London moves +0 → +1 on 29 March 2026 and back
 * on 25 October 2026; Pacific/Auckland moves the opposite way, +13 → +12 on
 * 5 April 2026. Auckland is in the set deliberately: it is the zone whose
 * offset an earlier implementation of this arithmetic normalised into ±12:00
 * and turned into -11.
 *
 * Test Coverage:
 * - Daily lands on the next local occurrence, today or tomorrow
 * - The local hour survives a spring-forward and an autumn-back, both directions
 * - Weekly lands on the right weekday in local terms, not server terms
 * - Monthly lands on the right day and rolls to the next month once passed
 * - A fractional-offset zone (India, +05:30) is not rounded to the hour
 * - Interval kinds ignore the timezone entirely
 * - Every kind returns a time strictly in the future
 *
 * @see lib/framework/resparkable/queue/kinds.ts
 */

import { describe, it, expect } from 'vitest';

import {
  nextDueAt,
  isResparkableJobKind,
  RESPARKABLE_JOB_KINDS,
  RESPARKABLE_JOB_SPECS,
} from '@/lib/framework/resparkable/queue/kinds';

/** What the clock in `zone` reads at `instant`, as `YYYY-MM-DD HH:mm`. */
function localReading(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

describe('daily kinds', () => {
  it('lands on today’s occurrence when it has not passed yet', () => {
    // 01:00 UTC, and triage is at 03:15. Two hours away, not twenty-six.
    const due = nextDueAt('triage', 'UTC', new Date('2026-06-15T01:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-15T03:15:00.000Z');
  });

  it('rolls to tomorrow once today’s occurrence has gone', () => {
    const due = nextDueAt('triage', 'UTC', new Date('2026-06-15T03:16:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-16T03:15:00.000Z');
  });

  it('is strictly after `from`, never equal to it', () => {
    // Exactly on the boundary. Returning `from` itself would let a worker
    // re-claim the row it just settled, in a tight loop, for ever.
    const at = new Date('2026-06-15T03:15:00.000Z');
    expect(nextDueAt('triage', 'UTC', at).getTime()).toBeGreaterThan(at.getTime());
  });

  it('resolves the local hour in the owner’s zone, not the server’s', () => {
    // Midnight UTC is midday in Auckland (+12 in June), so today's 03:15 local
    // has already gone and the next one is tomorrow's — at 15:15 UTC *today*.
    // A server-time reading would have said 03:15 UTC, which is mid-afternoon
    // for this person.
    const due = nextDueAt('triage', 'Pacific/Auckland', new Date('2026-06-15T00:00:00.000Z'));
    expect(localReading(due, 'Pacific/Auckland')).toBe('2026-06-16 03:15');
    expect(due.toISOString()).toBe('2026-06-15T15:15:00.000Z');
  });

  it('does not round a fractional offset to the hour', () => {
    // Asia/Kolkata is +05:30. An hours-only implementation puts this user's
    // briefing out by thirty minutes for ever — the kind of wrongness nobody
    // files a bug about, they just find it arrives at an odd time.
    const due = nextDueAt('briefing', 'Asia/Kolkata', new Date('2026-06-15T00:00:00.000Z'));
    expect(localReading(due, 'Asia/Kolkata')).toBe('2026-06-16 04:30');
    // 04:30 minus 05:30 is 23:00 the previous day. An hours-only offset would
    // land on 22:30 or 23:30 here, both of which read as the wrong local time.
    expect(due.toISOString()).toBe('2026-06-15T23:00:00.000Z');
  });
});

describe('DST — the reason this stores an instant and not a cron string', () => {
  it('keeps the local hour across a spring-forward', () => {
    // Europe/London goes +0 → +1 at 01:00 UTC on 2026-03-29. A run computed the
    // evening before must still land at 03:15 *local* on the far side.
    const before = new Date('2026-03-28T20:00:00.000Z');
    const first = nextDueAt('triage', 'Europe/London', before);
    expect(localReading(first, 'Europe/London')).toBe('2026-03-29 03:15');

    // And the one after it, computed from the far side, is the same local hour
    // at a different UTC instant. That difference is exactly what a stored cron
    // expression could not express.
    const second = nextDueAt('triage', 'Europe/London', first);
    expect(localReading(second, 'Europe/London')).toBe('2026-03-30 03:15');
    expect(first.toISOString()).toBe('2026-03-29T02:15:00.000Z');
    expect(second.toISOString()).toBe('2026-03-30T02:15:00.000Z');
  });

  it('keeps the local hour across an autumn-back', () => {
    // +1 → +0 at 02:00 local on 2026-10-25.
    const before = new Date('2026-10-24T20:00:00.000Z');
    const first = nextDueAt('triage', 'Europe/London', before);
    expect(localReading(first, 'Europe/London')).toBe('2026-10-25 03:15');
    expect(first.toISOString()).toBe('2026-10-25T03:15:00.000Z');

    // The day before the transition the same local hour was an hour earlier in
    // UTC — the drift a folded-in offset would have been carrying.
    const dayBefore = nextDueAt('triage', 'Europe/London', new Date('2026-10-23T20:00:00.000Z'));
    expect(dayBefore.toISOString()).toBe('2026-10-24T02:15:00.000Z');
  });

  it('keeps the local hour across a southern-hemisphere transition', () => {
    // Pacific/Auckland goes +13 → +12 on 2026-04-05. The zone an earlier
    // version of this arithmetic clamped into ±12:00 and read as -11.
    const due = nextDueAt('triage', 'Pacific/Auckland', new Date('2026-04-05T00:00:00.000Z'));
    expect(localReading(due, 'Pacific/Auckland')).toBe('2026-04-06 03:15');
  });
});

describe('weekly_review', () => {
  it('lands on the next Friday at the local hour', () => {
    // 2026-06-15 is a Monday.
    const due = nextDueAt('weekly_review', 'UTC', new Date('2026-06-15T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-19T16:00:00.000Z');
    expect(new Date(due).getUTCDay()).toBe(5);
  });

  it('takes today when today is Friday and 16:00 has not passed', () => {
    const due = nextDueAt('weekly_review', 'UTC', new Date('2026-06-19T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-19T16:00:00.000Z');
  });

  it('skips a week when Friday’s occurrence has gone', () => {
    const due = nextDueAt('weekly_review', 'UTC', new Date('2026-06-19T16:30:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-26T16:00:00.000Z');
  });

  it('is Friday on the OWNER’s calendar, which can be a different UTC day', () => {
    // 16:00 Friday in Auckland is 04:00 UTC on the same Friday; 16:00 Friday in
    // Los Angeles is 23:00 UTC on the Friday. The one that used to go wrong is
    // the zone far enough east that the UTC day differs — getting it wrong
    // turns a Friday review into a Thursday one.
    const auckland = nextDueAt(
      'weekly_review',
      'Pacific/Auckland',
      new Date('2026-06-15T00:00:00.000Z')
    );
    expect(localReading(auckland, 'Pacific/Auckland')).toBe('2026-06-19 16:00');
    expect(auckland.toISOString()).toBe('2026-06-19T04:00:00.000Z');
  });
});

describe('horizon_check', () => {
  it('lands on the 2nd at the local hour', () => {
    const due = nextDueAt('horizon_check', 'UTC', new Date('2026-06-01T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-02T09:00:00.000Z');
  });

  it('rolls into next month once this month’s has gone', () => {
    const due = nextDueAt('horizon_check', 'UTC', new Date('2026-06-02T09:30:00.000Z'));
    expect(due.toISOString()).toBe('2026-07-02T09:00:00.000Z');
  });

  it('rolls correctly from the 31st, where adding a month clamps', () => {
    // Adding a month to 31 January lands on 28 February in every sane
    // implementation, and truncating to the 2nd from there is right. Adding
    // thirty days would land in March.
    const due = nextDueAt('horizon_check', 'UTC', new Date('2026-01-31T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-02-02T09:00:00.000Z');
  });

  it('rolls across a year boundary', () => {
    const due = nextDueAt('horizon_check', 'UTC', new Date('2026-12-15T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2027-01-02T09:00:00.000Z');
  });
});

describe('interval kinds', () => {
  it('adds the period and ignores the timezone', () => {
    const from = new Date('2026-06-15T09:00:00.000Z');
    const utc = nextDueAt('sweep', 'UTC', from);
    const auckland = nextDueAt('sweep', 'Pacific/Auckland', from);

    expect(utc.toISOString()).toBe('2026-06-15T15:00:00.000Z');
    expect(auckland.getTime()).toBe(utc.getTime());
  });

  it('drains the reindex queue on a search-freshness cadence, not a nightly one', () => {
    // Fifteen minutes. Before this kind existed nothing drained `indexedHash`
    // on a schedule at all, so a captured thought was not findable by meaning
    // until somebody called `POST /resparkable/reindex` by hand.
    const due = nextDueAt('reindex', 'UTC', new Date('2026-06-15T09:00:00.000Z'));
    expect(due.toISOString()).toBe('2026-06-15T09:15:00.000Z');
  });
});

describe('the vocabulary', () => {
  it('every kind has a spec and produces a future due time in a hard zone', () => {
    const from = new Date('2026-03-29T00:30:00.000Z'); // mid spring-forward window
    for (const kind of RESPARKABLE_JOB_KINDS) {
      expect(RESPARKABLE_JOB_SPECS[kind]).toBeDefined();
      expect(nextDueAt(kind, 'Europe/London', from).getTime()).toBeGreaterThan(from.getTime());
    }
  });

  it('narrows an untrusted string', () => {
    // The database column is a plain VARCHAR, so a row written by a newer build
    // — or by hand — reaches the drain as an arbitrary string.
    expect(isResparkableJobKind('triage')).toBe(true);
    expect(isResparkableJobKind('TRIAGE')).toBe(false);
    expect(isResparkableJobKind('nightly_triage')).toBe(false);
  });

  it('gates every kind that spends credits', () => {
    // The rule the phase turns on: never debit a balance for a run that cannot
    // produce anything. A kind that spends and is not gated would bill someone
    // for reading an inbox nothing was added to.
    for (const kind of RESPARKABLE_JOB_KINDS) {
      const spec = RESPARKABLE_JOB_SPECS[kind];
      if (spec.spendsCredits) expect(spec.demandGated, kind).toBe(true);
    }
  });

  it('leaves retention ungated, because the calendar drives it and not activity', () => {
    // The deliberate exception. A 400-day-old event ages out of its window
    // whether or not its owner has touched anything, so gating retention would
    // stop it working for exactly the dormant brains whose data most needs
    // ageing out.
    expect(RESPARKABLE_JOB_SPECS.retention.demandGated).toBe(false);
    expect(RESPARKABLE_JOB_SPECS.retention.spendsCredits).toBe(false);
  });
});
