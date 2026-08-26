/**
 * Unit Tests: the job-queue repo's SQL.
 *
 * ## Why assert on SQL text at all
 *
 * Normally this would be a smell. Here two clauses are load-bearing in a way
 * that no behavioural test at this level can observe, and both fail silently if
 * they are removed:
 *
 * **`FOR UPDATE SKIP LOCKED`** is the entire reason this design scales. Without
 * it the claim degrades to every worker reading the same rows and all but one
 * losing the race — which is what `processDueSchedules` does today, and why its
 * throughput stops climbing exactly when you add workers to make it climb. A
 * drain with the clause removed still works, still passes every functional
 * test, and quietly stops benefiting from a second container.
 *
 * **`AND "leasedBy" = $worker` on the settle** is what stops a worker that
 * stalled past its lease from clobbering the row somebody else now holds.
 * Remove it and two workers can run the same job concurrently, in a window that
 * only opens under load. Nothing about either failure appears in a log line, so
 * the guard has to be a test.
 *
 * The rest of these assertions are about parameterisation: `userId` is never
 * interpolated into raw SQL anywhere in this tier, and a repo file is where
 * that would first go wrong.
 *
 * Test Coverage:
 * - The claim uses SKIP LOCKED, orders by dueAt, and joins the space for its zone
 * - The claim's lease window is computed from the passed `now`
 * - A non-positive batch size claims nothing rather than issuing SQL
 * - Both settles guard on the worker identity
 * - Dormancy is written only when the caller asked, so `undefined` leaves it alone
 * - Enqueue is ON CONFLICT DO NOTHING, one row per kind
 * - The forward-pull uses LEAST, so waking can only make a job more responsive
 * - The activity probe is an EXISTS, not a count
 *
 * @see lib/framework/resparkable/repo/jobs.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  claimResparkableJobs,
  clearResparkableJobDormancy,
  completeResparkableJob,
  countDueResparkableJobs,
  enqueueResparkableJobs,
  failResparkableJob,
  hasResparkableActivitySince,
  listSpacesWithoutJobs,
  pullResparkableJobsForward,
} from '@/lib/framework/resparkable/repo/jobs';
import { RESPARKABLE_JOB_KINDS } from '@/lib/framework/resparkable/queue/kinds';

const NOW = new Date('2026-06-15T12:00:00.000Z');

/**
 * A `Prisma.Sql` fragment, structurally. Composed fragments (`Prisma.sql`,
 * `Prisma.join`, `Prisma.empty`) arrive as one of these in the *values*
 * position, so both helpers below have to see through them or they read a
 * conditional clause as an opaque object.
 */
function isSqlFragment(value: unknown): value is { strings: string[]; values: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { strings?: unknown }).strings) &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

/**
 * The static half of the last tagged-template call, flattened.
 *
 * Prisma's `$queryRaw` receives a `TemplateStringsArray` plus the interpolated
 * values separately — which is the point, and is why nothing below can assert
 * that a value was inlined: it structurally cannot be. The `?` marks where a
 * parameter went, so an assertion can still tell "column mentioned" from
 * "column parameterised".
 */
function lastSql(mock: { mock: { calls: unknown[][] } }): string {
  const call = mock.mock.calls.at(-1) ?? [];
  const render = (strings: string[], values: unknown[]): string =>
    strings.reduce((text, part, index) => {
      const value = values[index];
      const rendered =
        value === undefined
          ? ''
          : isSqlFragment(value)
            ? render(value.strings, value.values)
            : ' ? ';
      return text + part + rendered;
    }, '');
  return render(call[0] as string[], call.slice(1));
}

/** The interpolated values from the last tagged-template call, fragments flattened. */
function lastValues(mock: { mock: { calls: unknown[][] } }): unknown[] {
  const flatten = (values: unknown[]): unknown[] =>
    values.flatMap((value) => (isSqlFragment(value) ? flatten(value.values) : [value]));
  return flatten((mock.mock.calls.at(-1) ?? []).slice(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
});

describe('claimResparkableJobs', () => {
  it('claims with SKIP LOCKED — the clause the whole design rests on', async () => {
    await claimResparkableJobs('worker-1', 4, 600_000, NOW);

    const sql = lastSql(vi.mocked(prisma.$queryRaw));
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    // Oldest-due first, so a backlog is drained in the order it accumulated
    // rather than newest-first, which would starve the most overdue brains.
    expect(sql).toContain('ORDER BY "dueAt" ASC');
  });

  it('reclaims a row whose lease has expired, and only then', async () => {
    // The lease is what makes reclaim a property of the clock rather than of a
    // reaper deciding what "stuck" means.
    const sql =
      (await claimResparkableJobs('worker-1', 4, 600_000, NOW),
      lastSql(vi.mocked(prisma.$queryRaw)));
    expect(sql).toContain('"leaseExpiresAt" IS NULL OR "leaseExpiresAt" <');
  });

  it('joins the space so the owner’s zone rides back with the claim', async () => {
    // Otherwise a worker draining fifty jobs issues fifty-one queries. The FK
    // guarantees the join matches, so it cannot narrow what is claimed.
    await claimResparkableJobs('worker-1', 4, 600_000, NOW);

    const sql = lastSql(vi.mocked(prisma.$queryRaw));
    expect(sql).toContain('FROM "framework_resparkable_space" s');
    expect(sql).toContain('s."timezone"');
  });

  it('computes the lease window from the passed clock, not the wall clock', async () => {
    await claimResparkableJobs('worker-1', 4, 600_000, NOW);

    expect(lastValues(vi.mocked(prisma.$queryRaw))).toContainEqual(
      new Date('2026-06-15T12:10:00.000Z')
    );
  });

  it('issues no SQL at all for a non-positive batch', async () => {
    // The drain computes `min(concurrency, remaining)`, which is zero on the
    // pass that has exhausted its budget. Claiming zero rows would still take a
    // round trip, and `LIMIT 0` is a query nobody meant to write.
    expect(await claimResparkableJobs('worker-1', 0, 600_000, NOW)).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('settling', () => {
  it('completes only under the identity that holds the lease', async () => {
    await completeResparkableJob('job_1', 'worker-1', { dueAt: NOW, lastRunAt: NOW }, NOW);

    const sql = lastSql(vi.mocked(prisma.$executeRaw));
    expect(sql).toContain('"leasedBy" =');
    expect(lastValues(vi.mocked(prisma.$executeRaw))).toContain('worker-1');
  });

  it('fails only under the identity that holds the lease', async () => {
    await failResparkableJob(
      'job_1',
      'worker-1',
      { dueAt: NOW, attempts: 1, lastError: 'boom' },
      NOW
    );

    expect(lastSql(vi.mocked(prisma.$executeRaw))).toContain('"leasedBy" =');
  });

  it('reports a stale settle as false rather than throwing', async () => {
    // Zero rows is the *correct* outcome for a worker whose lease expired: the
    // row belongs to somebody else now. Throwing would turn a benign race into
    // a logged error on every slow job.
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0);

    expect(
      await completeResparkableJob('job_1', 'worker-1', { dueAt: NOW, lastRunAt: NOW }, NOW)
    ).toBe(false);
  });

  it('leaves dormancy alone when the caller did not mention it', async () => {
    // Three states, not two: set it, clear it, or do not touch it. A settle
    // that always wrote the column would clear dormancy on every ordinary
    // completion of an ungated kind.
    await completeResparkableJob('job_1', 'worker-1', { dueAt: NOW, lastRunAt: NOW }, NOW);
    expect(lastSql(vi.mocked(prisma.$executeRaw))).not.toContain('"dormantSince"');
  });

  it('writes dormancy when the caller asked for it', async () => {
    await completeResparkableJob(
      'job_1',
      'worker-1',
      { dueAt: NOW, lastRunAt: null, dormantSince: NOW },
      NOW
    );
    expect(lastSql(vi.mocked(prisma.$executeRaw))).toContain('"dormantSince"');
  });
});

describe('enqueueResparkableJobs', () => {
  it('is an idempotent insert of one row per kind', async () => {
    const dueAt = Object.fromEntries(RESPARKABLE_JOB_KINDS.map((kind) => [kind, NOW]));

    await enqueueResparkableJobs('user_a', dueAt as never, NOW);

    const sql = lastSql(vi.mocked(prisma.$executeRaw));
    // Without this an enqueue that ran twice — on signup and again from the
    // backfill net — would violate the unique index and throw on a path that
    // must never fail a user's request.
    expect(sql).toContain('ON CONFLICT ("userId", "kind") DO NOTHING');
    for (const kind of RESPARKABLE_JOB_KINDS) {
      expect(lastValues(vi.mocked(prisma.$executeRaw))).toContain(kind);
    }
  });
});

describe('pullResparkableJobsForward', () => {
  it('uses LEAST, so waking a brain can only make it more responsive', async () => {
    // A dormant briefing parked a week out should come back to tomorrow's
    // 04:30. A reindex due in thirty seconds must NOT be pushed to fifteen
    // minutes because somebody wrote a note.
    await pullResparkableJobsForward('user_a', [{ kind: 'briefing', dueAt: NOW }], NOW);

    expect(lastSql(vi.mocked(prisma.$executeRaw))).toContain('LEAST("dueAt"');
  });

  it('issues nothing for an empty list', async () => {
    expect(await pullResparkableJobsForward('user_a', [], NOW)).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('the reads behind the gates', () => {
  it('probes activity with EXISTS rather than counting', async () => {
    // The answer is a boolean, and a brain with fifty thousand events should
    // not pay to learn it. `EXISTS` stops at the first row.
    await hasResparkableActivitySince('user_a', NOW);

    const sql = lastSql(vi.mocked(prisma.$queryRaw));
    expect(sql).toContain('SELECT EXISTS');
    expect(sql).not.toContain('count(');
  });

  it('reports no activity when the probe comes back empty', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    expect(await hasResparkableActivitySince('user_a', NOW)).toBe(false);
  });

  it('finds brains with no job rows by anti-join', async () => {
    await listSpacesWithoutJobs(5);

    expect(lastSql(vi.mocked(prisma.$queryRaw))).toContain('WHERE NOT EXISTS');
  });

  it('counts only the rows a worker could actually claim', async () => {
    // Depth is the number that matters under backlog: the row count is
    // invariant by design, so this is the only thing that shows workers falling
    // behind. Counting leased rows would flatter it.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ due: 42n }] as never);

    expect(await countDueResparkableJobs(NOW)).toBe(42);
    expect(lastSql(vi.mocked(prisma.$queryRaw))).toContain('"leaseExpiresAt" IS NULL');
  });

  it('clears dormancy only where there is dormancy to clear', async () => {
    // This runs behind every activity-log write, so on an active brain it has
    // to match nothing and stop.
    await clearResparkableJobDormancy('user_a', NOW);

    expect(lastSql(vi.mocked(prisma.$queryRaw))).toContain('"dormantSince" IS NOT NULL');
  });
});

describe('parameterisation', () => {
  it('never interpolates the owner id into the SQL text', async () => {
    // The tier's standing rule for raw SQL. A repo file is where it would first
    // go wrong, and the failure is an injection rather than a wrong answer.
    await hasResparkableActivitySince('user_a', NOW);
    await claimResparkableJobs('worker-1', 2, 1000, NOW);

    for (const call of vi.mocked(prisma.$queryRaw).mock.calls) {
      expect((call[0] as unknown as string[]).join(' ')).not.toContain('user_a');
    }
  });
});
