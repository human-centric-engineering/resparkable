/**
 * Unit Tests: enqueue, wake and the backfill net.
 *
 * Three writes, all best-effort, all sitting behind something a person is
 * waiting on — creating their space, capturing a thought, completing a task. A
 * background job that arrives late is a smaller problem than a capture that
 * 500s, so every one of these swallows its own failure. These tests pin that,
 * because "swallows failures" is exactly the property that rots into "silently
 * does nothing" if nobody asserts the happy path too.
 *
 * The wake is the interesting one. It runs behind **every** activity-log write,
 * so its cost on an active brain has to be one index probe: a single UPDATE
 * that matches nothing, and no timezone lookup at all. Only a genuine
 * return-from-absence pays for the rest.
 *
 * Test Coverage:
 * - Enqueue writes one due time per kind, from the owner's timezone
 * - Enqueue swallows a database failure rather than failing a signup
 * - A wake on an active brain does one query and stops
 * - A wake on a dormant brain looks the timezone up and pulls due times forward
 * - A woken kind this build does not recognise is skipped, not crashed on
 * - The backfill net is a no-op when every brain has its rows
 *
 * @see lib/framework/resparkable/queue/enqueue.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/jobs', () => ({
  enqueueResparkableJobs: vi.fn(),
  clearResparkableJobDormancy: vi.fn(),
  pullResparkableJobsForward: vi.fn(),
  listSpacesWithoutJobs: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/space', () => ({
  findSpaceByUserId: vi.fn(),
}));

import {
  backfillMissingResparkableJobs,
  ensureResparkableJobs,
  wakeResparkableJobs,
} from '@/lib/framework/resparkable/queue/enqueue';
import {
  clearResparkableJobDormancy,
  enqueueResparkableJobs,
  listSpacesWithoutJobs,
  pullResparkableJobsForward,
} from '@/lib/framework/resparkable/repo/jobs';
import { findSpaceByUserId } from '@/lib/framework/resparkable/repo/space';
import { RESPARKABLE_JOB_KINDS } from '@/lib/framework/resparkable/queue/kinds';

const NOW = new Date('2026-06-15T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enqueueResparkableJobs).mockResolvedValue(7);
  vi.mocked(pullResparkableJobsForward).mockResolvedValue(0);
});

describe('ensureResparkableJobs', () => {
  it('writes a due time for every kind, resolved in the owner’s zone', async () => {
    await ensureResparkableJobs('user_a', 'Pacific/Auckland', NOW);

    const dueAtByKind = vi.mocked(enqueueResparkableJobs).mock.calls[0]?.[1] as Record<
      string,
      Date
    >;
    expect(Object.keys(dueAtByKind).sort()).toEqual([...RESPARKABLE_JOB_KINDS].sort());
    // Noon UTC is midnight in Auckland (+12), so the next 03:15 on this
    // person's clock is three and a quarter hours away — at 15:15 UTC on the
    // 15th, for a local time on the 16th. A server-time answer would have said
    // 03:15Z, which is mid-afternoon for them.
    expect(dueAtByKind.triage?.toISOString()).toBe('2026-06-15T15:15:00.000Z');
  });

  it('swallows a failure rather than 500ing a first page load', async () => {
    // This runs on the read path of a brand-new brain. The backfill net picks
    // up anything it misses, which is why swallowing here is safe rather than
    // merely convenient.
    vi.mocked(enqueueResparkableJobs).mockRejectedValue(new Error('pool exhausted'));

    await expect(ensureResparkableJobs('user_a', 'UTC', NOW)).resolves.toBe(0);
  });
});

describe('wakeResparkableJobs', () => {
  it('costs one query on an active brain', async () => {
    // The common case by an enormous margin — this runs behind every mutation
    // in the tier. A timezone lookup here would put an extra read on every
    // capture, every completion, every edit.
    vi.mocked(clearResparkableJobDormancy).mockResolvedValue([]);

    const woken = await wakeResparkableJobs('user_a', NOW);

    expect(woken).toBe(0);
    expect(findSpaceByUserId).not.toHaveBeenCalled();
    expect(pullResparkableJobsForward).not.toHaveBeenCalled();
  });

  it('pulls a dormant brain’s due times back to their natural cadence', async () => {
    // Returning after three months has to cost one cycle, not thirteen. The
    // briefing parked a week out comes back to tomorrow morning.
    vi.mocked(clearResparkableJobDormancy).mockResolvedValue([
      { kind: 'briefing', dueAt: new Date('2026-06-22T04:30:00.000Z') },
    ]);
    vi.mocked(findSpaceByUserId).mockResolvedValue({ timezone: 'UTC' } as never);

    const woken = await wakeResparkableJobs('user_a', NOW);

    expect(woken).toBe(1);
    expect(vi.mocked(pullResparkableJobsForward).mock.calls[0]?.[1]).toEqual([
      { kind: 'briefing', dueAt: new Date('2026-06-16T04:30:00.000Z') },
    ]);
  });

  it('falls back to UTC rather than throwing when the space is gone', async () => {
    // Cannot happen — the FK is ON DELETE CASCADE — but this path must never
    // throw, because it runs inside a mutation the user is waiting on.
    vi.mocked(clearResparkableJobDormancy).mockResolvedValue([
      { kind: 'triage', dueAt: new Date('2026-06-22T03:15:00.000Z') },
    ]);
    vi.mocked(findSpaceByUserId).mockResolvedValue(null);

    await expect(wakeResparkableJobs('user_a', NOW)).resolves.toBe(1);
  });

  it('skips a kind this build does not recognise', async () => {
    // A rolling deploy: an older process reads a row a newer one wrote. It has
    // no cadence for it, so it leaves that row's due time alone rather than
    // guessing at one.
    vi.mocked(clearResparkableJobDormancy).mockResolvedValue([
      { kind: 'briefing', dueAt: new Date('2026-06-22T04:30:00.000Z') },
      { kind: 'quarterly_wibble', dueAt: new Date('2026-06-22T04:30:00.000Z') },
    ]);
    vi.mocked(findSpaceByUserId).mockResolvedValue({ timezone: 'UTC' } as never);

    await wakeResparkableJobs('user_a', NOW);

    const forwarded = vi.mocked(pullResparkableJobsForward).mock.calls[0]?.[1] as Array<{
      kind: string;
    }>;
    expect(forwarded.map((row) => row.kind)).toEqual(['briefing']);
  });

  it('swallows a failure rather than failing the mutation behind it', async () => {
    vi.mocked(clearResparkableJobDormancy).mockRejectedValue(new Error('deadlock'));

    await expect(wakeResparkableJobs('user_a', NOW)).resolves.toBe(0);
  });
});

describe('backfillMissingResparkableJobs', () => {
  it('is a no-op when every brain has its rows', async () => {
    // Which is every tick but a handful in the life of an install. It has to be
    // cheap enough that running it unconditionally is not a cost.
    vi.mocked(listSpacesWithoutJobs).mockResolvedValue([]);

    expect(await backfillMissingResparkableJobs(5, NOW)).toBe(0);
    expect(enqueueResparkableJobs).not.toHaveBeenCalled();
  });

  it('enqueues for each brain that has none, in its own timezone', async () => {
    // The net under the fire-and-forget enqueue on signup. Before phase 56 the
    // equivalent was the sweep rotation reaching every brain in turn; without a
    // replacement a brain that missed its enqueue would have no background work
    // for ever, and nothing anywhere would say so.
    vi.mocked(listSpacesWithoutJobs).mockResolvedValue([
      { userId: 'user_a', timezone: 'UTC' },
      { userId: 'user_b', timezone: 'Asia/Tokyo' },
    ]);

    expect(await backfillMissingResparkableJobs(5, NOW)).toBe(14);
    expect(vi.mocked(enqueueResparkableJobs).mock.calls.map((call) => call[0])).toEqual([
      'user_a',
      'user_b',
    ]);
  });
});
