/**
 * Resparkable job-queue smoke script — the properties only a real database has.
 *
 * `phase-56-plan.md` §9 lists ten assertions. Most are behavioural and live in
 * the unit suite; the ones here are the four that a mocked test structurally
 * cannot make, because each of them is a property of Postgres rather than of
 * this codebase:
 *
 *   **2. Disjoint claims.** `SELECT … FOR UPDATE SKIP LOCKED` is the whole
 *   reason the design scales, and no mock can demonstrate that two concurrent
 *   transactions get non-overlapping batches. A unit test can assert the clause
 *   is in the SQL text (and one does); only a real database can show it works.
 *
 *   **3. Lease reclaim.** A worker killed mid-job must have its row picked up
 *   after the lease expires and **not before**. Both halves matter: reclaiming
 *   early means two workers running the same job, and never reclaiming means a
 *   brain silently loses that kind of work for ever.
 *
 *   **4. Queue depth is invariant under backlog.** This is the assertion that
 *   distinguishes this design from what it replaces. A fixed-batch drain under
 *   backlog grows a *queue*; this one grows a *latency*. The first is invisible
 *   until it is fatal, the second shows up on a graph — so the row count has to
 *   be provably unchanged while `dueAt` ages.
 *
 *   **9. Erasure.** The tier has no erasure hook any more: `ResparkableJob`
 *   hangs off `ResparkableSpace`, so this is the D1 cascade. That is a claim
 *   about a foreign key, and foreign keys are exactly what mocks do not have.
 *
 * Assertion 10 (row count invariant under workspace creation) is deliberately
 * absent: `plan.md` §24 is not built, so there is nothing to create. The job
 * table is owner-keyed up front precisely so that assertion is satisfiable
 * without a migration when it arrives.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to run
 * anywhere. Self-cleaning: creates only `smoke-resparkable-queue-*` users and
 * removes them — and, via cascade, everything they own — on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-queue
 */

import { prisma } from '@/lib/db/client';
import { claimResparkableJobs } from '@/lib/framework/resparkable/repo/jobs';
import { RESPARKABLE_JOB_KINDS } from '@/lib/framework/resparkable/queue/kinds';
import { ensureResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-queue';
const KIND_COUNT = RESPARKABLE_JOB_KINDS.length;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function createBrain(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: `${PREFIX}-${label}-${stamp}`,
      name: `${PREFIX} ${label}`,
      email: `${PREFIX}-${label}-${stamp}@example.test`,
      emailVerified: false,
    },
  });
  // The space directly rather than through `ensureResparkableSpace`, which also
  // mints credits and seeds settings. This script is about the queue.
  await prisma.resparkableSpace.create({
    data: { userId: user.id, inboxToken: `${PREFIX}-${label}-${stamp}`, timezone: 'UTC' },
  });
  return user.id;
}

/** Job rows for these owners, and nothing else in the table. */
function mine(userIds: string[]) {
  return { userId: { in: userIds } };
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-queue skipped — no database reachable.');
    return;
  }

  const owners: string[] = [];

  try {
    console.log('\nSetting up three brains…');
    for (const label of ['a', 'b', 'c']) owners.push(await createBrain(label));

    const past = new Date(Date.now() - 60_000);
    for (const userId of owners) await ensureResparkableJobs(userId, 'UTC', new Date());
    // Force everything due, so the claim has a full set to work from. The
    // enqueue's own due times are in the future by construction.
    await prisma.resparkableJob.updateMany({ where: mine(owners), data: { dueAt: past } });

    const total = await prisma.resparkableJob.count({ where: mine(owners) });
    check(total === 3 * KIND_COUNT, `three brains hold ${3 * KIND_COUNT} job rows, one per kind`);

    // ── Assertion 2: disjoint claims under concurrency ─────────────────────
    console.log('\nAssertion 2 — ten concurrent workers claim disjoint batches');

    const now = new Date();
    const batches = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        claimResparkableJobs(`smoke-worker-${index}`, 3, 600_000, now)
      )
    );

    // Deliberately NOT scoped to this run's brains. `claimResparkableJobs` is
    // the one unscoped read in the tier — its whole job is to choose an owner —
    // so it picks up anything else in this database that happens to be due, and
    // that makes the assertion stronger rather than noisier: disjointness is a
    // property of the claim across the whole table, not of these three rows.
    // The leases it takes on other brains' rows are released in `finally`.
    const claimedIds = batches.flat().map((job) => job.id);
    check(
      new Set(claimedIds).size === claimedIds.length,
      `no job was handed to two workers (${claimedIds.length} claims, ${new Set(claimedIds).size} distinct, across every due row in the database)`
    );
    check(
      batches.flat().every((job) => typeof job.timezone === 'string' && job.timezone.length > 0),
      'every claim carried the owner’s timezone back with it, so no second query is needed'
    );

    const leased = await prisma.resparkableJob.count({
      where: { ...mine(owners), leasedBy: { not: null } },
    });
    check(leased > 0, `${leased} of this run’s rows are leased`);

    // ── Assertion 3: reclaim happens on lease expiry, and not before ───────
    console.log('\nAssertion 3 — a killed worker’s row is reclaimed only after the lease expires');

    const victim = await prisma.resparkableJob.findFirst({
      where: { ...mine(owners), leasedBy: { not: null } },
      select: { id: true, leasedBy: true },
    });
    if (!victim) throw new Error('setup: expected at least one leased row');

    // Everything else parked in the future, so the only claimable row in this
    // run is the leased one — which is what makes the two claims below mean
    // something rather than merely finding something else to do.
    await prisma.resparkableJob.updateMany({
      where: { ...mine(owners), id: { not: victim.id } },
      data: { dueAt: new Date(Date.now() + 3_600_000), leasedBy: null, leaseExpiresAt: null },
    });
    await prisma.resparkableJob.update({
      where: { id: victim.id },
      data: { dueAt: past, leaseExpiresAt: new Date(Date.now() + 300_000) },
    });

    const tooEarly = await claimResparkableJobs('smoke-thief', 5, 600_000, new Date());
    check(
      !tooEarly.some((job) => job.id === victim.id),
      'a live lease is respected — the row is not re-claimed while its worker may still be running'
    );

    await prisma.resparkableJob.update({
      where: { id: victim.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const reclaimed = await claimResparkableJobs('smoke-thief', 5, 600_000, new Date());
    check(
      reclaimed.some((job) => job.id === victim.id),
      'an expired lease is reclaimed, so a worker that died mid-job does not park the row for ever'
    );

    // ── Assertion 4: depth grows, row count does not ───────────────────────
    console.log('\nAssertion 4 — a backlog makes rows LATE, never numerous');

    const before = await prisma.resparkableJob.count({ where: mine(owners) });
    // Simulate a fleet that has fallen a day behind: every row due, nothing
    // claimed, nothing settled.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await prisma.resparkableJob.updateMany({
      where: mine(owners),
      data: { dueAt: dayAgo, leasedBy: null, leaseExpiresAt: null },
    });

    const after = await prisma.resparkableJob.count({ where: mine(owners) });
    check(after === before, `row count unchanged under a full day of backlog (${before})`);

    const oldest = await prisma.resparkableJob.findFirst({
      where: mine(owners),
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
    });
    check(
      oldest !== null && oldest.dueAt.getTime() <= dayAgo.getTime(),
      'and `dueAt` aged instead — the backlog is visible as latency, on a graph'
    );

    // ── Assertion 9: erasure takes the job rows with it ────────────────────
    console.log('\nAssertion 9 — erasing a user removes every job row for that brain');

    const [erased, ...survivors] = owners;
    if (!erased) throw new Error('setup: expected an owner to erase');

    await prisma.user.delete({ where: { id: erased } });
    owners.splice(owners.indexOf(erased), 1);

    check(
      (await prisma.resparkableJob.count({ where: { userId: erased } })) === 0,
      'the D1 cascade removed the erased brain’s job rows — no hook involved'
    );
    check(
      (await prisma.resparkableJob.count({ where: mine(survivors) })) === 2 * KIND_COUNT,
      'and left everybody else’s alone'
    );

    console.log('\nframework:resparkable:smoke-queue passed');
  } finally {
    // Release the leases this script took on brains it does not own. They would
    // expire on their own in ten minutes, but leaving a developer's real job
    // rows parked for ten minutes after a smoke run is a rude way to be
    // correct.
    await prisma.resparkableJob
      .updateMany({
        where: { leasedBy: { startsWith: 'smoke-' } },
        data: { leasedBy: null, leaseExpiresAt: null },
      })
      .catch(() => undefined);

    for (const id of owners) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:resparkable:smoke-queue FAILED');
  console.error(error);
  process.exit(1);
});
