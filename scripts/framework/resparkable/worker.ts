/**
 * `npm run resparkable:worker` — the standalone drain loop.
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open on a sleep we are about to abandon.
    timer.unref?.();
  });

async function main(): Promise<void> {
  const workerId = `worker-${process.pid}-${process.env.HOSTNAME ?? 'local'}`.slice(0, 64);
  logger.info('Resparkable worker started', { workerId, concurrency: CONCURRENCY });

  while (running) {
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
        workerId,
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
