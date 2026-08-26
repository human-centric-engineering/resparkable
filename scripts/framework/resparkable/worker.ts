/**
 * `npm run framework:resparkable:worker` — the standalone drain loop.
 *
 * ## Why this exists, and why it is optional
 *
 * `drainResparkableJobs` is a bounded call, and the maintenance tick already
 * makes it: a few jobs, twenty seconds, once a minute. That is enough for a
 * single-container install and it is what a fork running Resparkable for a team
 * of thirty gets with no extra process and no configuration.
 *
 * This entrypoint is the same function with a bigger budget in a loop. It is
 * what an install at scale runs — six of them, say, alongside the web
 * containers — and it needs no code change of any kind to switch between the
 * two, because the lease that makes concurrent draining safe lives in the
 * database rather than in this process.
 *
 * **Deployment topology is the operator's choice rather than the module's
 * requirement.** That is the whole argument for Resparkable owning a dispatcher
 * at all (`phase-56-plan.md` §5), and it only holds because this file is
 * optional.
 *
 * ## Running more than one
 *
 * Safe by construction. `claimResparkableJobs` uses `SELECT … FOR UPDATE SKIP
 * LOCKED`, so N workers get N disjoint batches from one statement rather than
 * contending over the same rows — throughput climbs roughly linearly with
 * workers instead of flattening the way an optimistic lock does.
 *
 * Set `RESPARKABLE_WORKER_MODE=external` on the **web** containers when running
 * these, so the tick stops draining and leaves the queue to them. That is a
 * throughput choice, not a correctness one: leaving it unset costs contention,
 * never double runs.
 *
 * ## Shutdown
 *
 * SIGTERM and SIGINT stop the loop after the batch in flight finishes, rather
 * than mid-job. A job abandoned mid-run is not *wrong* — the lease expires and
 * somebody re-claims it — but it is ten minutes of latency for that brain and a
 * half-written run in the log, and a container being rolled during a deploy
 * should not cost either.
 */

import { randomUUID } from 'node:crypto';

import { drainResparkableJobs } from '@/lib/framework/resparkable/queue/drain';
import { countDueResparkableJobs } from '@/lib/framework/resparkable/repo/jobs';
import { logger } from '@/lib/logging';

/** How much one pass takes on before reporting and looking again. */
const MAX_JOBS_PER_PASS = 200;
const MAX_WALL_CLOCK_MS = 60_000;

/**
 * Jobs run at once by one worker.
 *
 * Each job is mostly database round-trips, so this is a connection-pool number
 * rather than a CPU one — eight concurrent jobs against a pool of ten leaves
 * room for the claim and the settle. Raise it with the pool, not on its own.
 */
const CONCURRENCY = 8;

/**
 * How long to wait after finding the queue empty.
 *
 * Short enough that a job coming due is picked up promptly, long enough that an
 * idle install is not running a claim query twice a second. The claim is a
 * single indexed statement, so this is about not generating noise rather than
 * about cost.
 */
const IDLE_SLEEP_MS = 5_000;

let running = true;

function stop(signal: string): void {
  if (!running) return;
  running = false;
  logger.info('Resparkable worker stopping after the current batch', { signal });
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

/**
 * The idle wait. Deliberately **not** `unref`'d.
 *
 * An `unref`'d timer does not hold the event loop open, so once the queue is
 * empty and this sleep is the only pending work, whether the process survives
 * depends on something else happening to keep the loop referenced — signal
 * handlers do not, and a Prisma client sitting idle is not a guarantee either.
 * The failure that buys you is a worker container that exits 0 the first time
 * it finds nothing to do and gets restart-looped by its supervisor, which reads
 * as a crashing worker rather than an idle one.
 *
 * It could not be reproduced in this environment, which is precisely the
 * argument for removing it: correctness here should not rest on which other
 * handle happens to be open. Shutdown does not need it — `stop()` sets
 * `running`, and the loop exits after at most one idle interval.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A lease token, fresh for every pass.
 *
 * **Not a stable per-process id**, and the difference is the whole point of the
 * `leasedBy` guard on the settle. `repo/jobs.ts` matches on it so that a worker
 * whose lease lapsed mid-run cannot clear the lease of whoever holds the row
 * now — and a *stable* id defeats exactly that, because two identities can
 * collide. `worker-${pid}-${HOSTNAME}` looks unique and is not: in a container
 * the main process is PID 1, and an image that does not set `HOSTNAME` gives
 * every replica `worker-1-local`. Two such workers can settle each other's
 * rows, which lets a third claim a job that is still running.
 *
 * A random token per pass costs nothing and makes the guard mean what it says.
 * The pid and host stay in it because a lease that cannot be traced back to a
 * container is a lease nobody can debug.
 */
function leaseToken(): string {
  return `w-${process.pid}-${process.env.HOSTNAME ?? 'local'}-${randomUUID().slice(0, 8)}`.slice(
    0,
    64
  );
}

async function main(): Promise<void> {
  const label = `worker-${process.pid}`;
  logger.info('Resparkable worker started', { worker: label, concurrency: CONCURRENCY });

  while (running) {
    const workerId = leaseToken();
    const result = await drainResparkableJobs({
      workerId,
      maxJobs: MAX_JOBS_PER_PASS,
      maxWallClockMs: MAX_WALL_CLOCK_MS,
      concurrency: CONCURRENCY,
    });

    if (result.settled > 0) {
      // `due` is read after the pass rather than before, so the number means
      // "still waiting" rather than "was waiting". Under a backlog this is the
      // figure that should be watched: the queue's row count is invariant by
      // design, so depth here is the only thing that shows the workers falling
      // behind, and it shows it as a rising line rather than as a cliff.
      const due = await countDueResparkableJobs(new Date());
      logger.info('Resparkable worker pass complete', {
        worker: label,
        lease: workerId,
        settled: result.settled,
        skippedDormant: result.skippedDormant,
        skippedNoCredit: result.skippedNoCredit,
        failed: result.failed,
        executionsQueued: result.outcome.executionsQueued,
        stillDue: due,
      });
    }

    // Only sleep on a genuinely empty queue. A pass that stopped because it hit
    // its budget has work waiting, and pausing on it would idle a worker in
    // front of a backlog.
    if (result.queueEmpty && running) await sleep(IDLE_SLEEP_MS);
  }

  logger.info('Resparkable worker stopped');
}

main().catch((error: unknown) => {
  // A throw here is the loop itself failing — the database being unreachable,
  // say — not a job failing, which `drainResparkableJobs` handles internally and
  // never propagates. Exiting non-zero lets the supervisor restart it, which is
  // the right response: the queue is durable, so a restart resumes rather than
  // loses anything.
  logger.error('Resparkable worker crashed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
